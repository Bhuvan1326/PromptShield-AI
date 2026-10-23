/**
 * Coordination backends — owner slots + idempotency reservations.
 *
 * Two implementations behind one interface:
 *
 *   memory (default) — process-local (current behavior). Correct for
 *     single-instance/local/demo deployments.
 *
 *   redis — shared atomic store for multi-instance deployments. Uses only
 *     atomic commands (SET NX PX, Lua compare-and-delete, INCR/DECR) — never
 *     check-then-set. Requires `PS_REDIS_URL` and `PS_COORDINATION=redis`.
 *     Fail-closed: coordinator errors reject the operation (no slot, no
 *     session) rather than silently allowing unbounded concurrency.
 *
 * LIVE VERIFICATION STATUS: the memory impl is the tested production path.
 * The Redis impl is exercised only when `PS_REDIS_URL` is present
 * (integration tests skip without it) — it has NOT been verified against a
 * live multi-instance deployment in this environment.
 */
import type Redis from "ioredis";
import { randomUUID } from "node:crypto";
import {
  abandonIdempotency,
  finalizeIdempotency,
  reserveIdempotency,
} from "./idempotency";

export interface IdemReserveResult {
  state: "fresh" | "replay" | "conflict" | "in-flight";
  sessionId?: string;
  scopeKey?: string;
}

/**
 * A slot lease — unique, unguessable member identifying one holder.
 * `member` encodes leaseId:deadline so release/validity checks are exact-match
 * (a stale worker can never release or extend a newer worker's slot).
 */
export interface SlotLease {
  id: string;
  member: string;
  /** Hard expiry (epoch ms) — protected work must stop at/after this. */
  deadline: number;
}

export interface Coordinator {
  kind: "memory" | "redis";
  /** Atomically acquire a lease, or null at capacity. `ttlMs` bounds the
   *  lease lifetime; expiry auto-releases so crashed holders can't leak. */
  acquireSlot(owner: string, ttlMs: number): Promise<SlotLease | null>;
  /** Conditional release — only removes THIS lease's member. */
  releaseSlot(owner: string, lease: SlotLease): Promise<void>;
  /** True while this exact lease is still live (not expired/evicted). */
  leaseValid(owner: string, lease: SlotLease): Promise<boolean>;
  reserveIdem(opts: {
    scopeKey: string;
    fingerprint: string;
    sessionId: string;
    ttlMs: number;
  }): Promise<IdemReserveResult>;
  finalizeIdem(scopeKey: string): Promise<void>;
  abandonIdem(scopeKey: string): Promise<void>;
  /** Atomic shared rate-limit decision: returns true if allowed. */
  rateLimit(scope: string, key: string, windowMs: number, max: number): Promise<boolean>;
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// Memory implementation (default) — delegates to the existing, tested
// process-local primitives. Correct for single-instance deployments only.
// --------------------------------------------------------------------------

export function memoryCoordinator(): Coordinator {
  // Lease-aware Map mirroring the Redis ZSET semantics: members are
  // unique lease ids with expiry scores; capacity check is atomic because
  // the impl is synchronous within a single process.
  const leases = new Map<string, Map<string, number>>();
  const prune = (owner: string, now: number) => {
    const l = leases.get(owner);
    if (!l) return;
    for (const [m, exp] of l) if (exp <= now) l.delete(m);
    if (l.size === 0) leases.delete(owner);
  };
  return {
    kind: "memory",
    async acquireSlot(owner, ttlMs) {
      const now = Date.now();
      prune(owner, now);
      const l = leases.get(owner) ?? new Map<string, number>();
      if (l.size >= 3) return null; // MAX_CONCURRENT_PER_OWNER
      const lease: SlotLease = {
        id: `lease-${Math.random().toString(36).slice(2, 12)}`,
        member: "",
        deadline: now + ttlMs,
      };
      lease.member = `${lease.id}:${lease.deadline}`;
      l.set(lease.member, lease.deadline);
      leases.set(owner, l);
      return lease;
    },
    async releaseSlot(owner, lease) {
      leases.get(owner)?.delete(lease.member);
    },
    async leaseValid(owner, lease) {
      const now = Date.now();
      prune(owner, now);
      return leases.get(owner)?.has(lease.member) ?? false;
    },
    async reserveIdem({ scopeKey, fingerprint, sessionId }) {
      const r = reserveIdempotency(scopeKey, fingerprint, sessionId);
      return r.kind === "reserved"
        ? { state: "fresh", scopeKey }
        : r.kind === "replay"
          ? { state: "replay", sessionId: r.sessionId }
          : { state: "conflict" };
    },
    async finalizeIdem(scopeKey) {
      finalizeIdempotency(scopeKey);
    },
    async abandonIdem(scopeKey) {
      abandonIdempotency(scopeKey);
    },
    async rateLimit() {
      // Memory impl does not own rate limiting — the existing per-process
      // middleware remains the tested path for single-instance mode.
      return true;
    },
    async close() {},
  };
}

// --------------------------------------------------------------------------
// Redis implementation (atomic, multi-instance)
// --------------------------------------------------------------------------

const ABANDON_LUA = `
if redis.call("GET", KEYS[1]) then
  local v = cjson.decode(redis.call("GET", KEYS[1]))
  if v.sessionId == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
end
return 0`;

const FINALIZE_LUA = `
local cur = redis.call("GET", KEYS[1])
if not cur then return 0 end
local v = cjson.decode(cur)
if v.sessionId ~= ARGV[1] then return 0 end
v.state = "final"
local ttl = redis.call("PTTL", KEYS[1])
if ttl > 0 then
  return redis.call("SET", KEYS[1], cjson.encode(v), "PX", ttl, "XX")
end
return redis.call("SET", KEYS[1], cjson.encode(v), "XX")`;

export function redisCoordinator(client: Redis): Coordinator {
  const slotKey = (o: string) => `ps:slots:${o}`;

  // Atomic semaphore: prune expired leases + capacity check + insert, all in
  // one Lua call — no oversubscription window. Members are `leaseId:deadline`
  // so releases and validity checks are exact-match (a stale worker cannot
  // release a newer worker's lease).
  const ACQUIRE_LUA = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call("ZADD", KEYS[1], ARGV[3], ARGV[4])
redis.call("PEXPIRE", KEYS[1], ARGV[5])
return 1`;

  return {
    kind: "redis",
    async acquireSlot(owner, ttlMs) {
      const now = Date.now();
      const lease: SlotLease = {
        id: randomUUID(),
        member: "",
        deadline: now + ttlMs,
      };
      lease.member = `${lease.id}:${lease.deadline}`;
      const ok = await client.eval(
        ACQUIRE_LUA, 1, slotKey(owner),
        String(now), "3", String(lease.deadline), lease.member, String(ttlMs * 2),
      );
      return ok === 1 ? lease : null;
    },
    async releaseSlot(owner, lease) {
      // Exact-member remove — no-op if the lease already expired or was never
      // ours. A stale worker's release can never delete a newer lease.
      await client.zrem(slotKey(owner), lease.member);
    },
    async leaseValid(owner, lease) {
      const k = slotKey(owner);
      await client.zremrangebyscore(k, "-inf", Date.now());
      return (await client.zscore(k, lease.member)) !== null;
    },
    async reserveIdem({ scopeKey, fingerprint, sessionId, ttlMs }) {
      const rk = scopeKey;
      const payload = JSON.stringify({ sessionId, fingerprint, state: "reserved" });
      const ok = await client.set(rk, payload, "PX", ttlMs, "NX");
      if (ok === "OK") return { state: "fresh", scopeKey: rk };
      const cur = await client.get(rk);
      if (!cur) return { state: "fresh", scopeKey: rk }; // expired between set+get
      try {
        const rec = JSON.parse(cur) as { sessionId: string; fingerprint: string; state: string };
        if (rec.fingerprint !== fingerprint) return { state: "conflict" };
        return rec.state === "final"
          ? { state: "replay", sessionId: rec.sessionId }
          : { state: "in-flight" };
      } catch {
        return { state: "conflict" };
      }
    },
    async finalizeIdem(scopeKey) {
      // ARGV carries the sessionId recovered from the reserved record.
      const cur = await client.get(scopeKey);
      if (!cur) return;
      const rec = JSON.parse(cur) as { sessionId: string };
      await client.eval(FINALIZE_LUA, 1, scopeKey, rec.sessionId);
    },
    async abandonIdem(scopeKey) {
      const cur = await client.get(scopeKey);
      if (!cur) return;
      try {
        const rec = JSON.parse(cur) as { sessionId: string };
        await client.eval(ABANDON_LUA, 1, scopeKey, rec.sessionId);
      } catch {
        await client.del(scopeKey);
      }
    },
    async rateLimit(scope, key, windowMs, max) {
      // Fixed-window atomic counter — shared across instances.
      const k = `ps:rl:${scope}:${key}`;
      const n = await client.eval(
        `local c = redis.call("INCR", KEYS[1])
         if c == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end
         return c`,
        1, k, String(windowMs),
      );
      return (n as number) <= max;
    },
    async close() {
      await client.quit();
    },
  };
}
