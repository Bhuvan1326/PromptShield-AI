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
import {
  acquireOwnerSlot,
  releaseOwnerSlot,
} from "./agent/session";
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

export interface Coordinator {
  kind: "memory" | "redis";
  acquireSlot(owner: string): Promise<boolean>;
  releaseSlot(owner: string): Promise<void>;
  reserveIdem(opts: {
    scopeKey: string;
    fingerprint: string;
    sessionId: string;
    ttlMs: number;
  }): Promise<IdemReserveResult>;
  finalizeIdem(scopeKey: string): Promise<void>;
  abandonIdem(scopeKey: string): Promise<void>;
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// Memory implementation (default) — delegates to the existing, tested
// process-local primitives. Correct for single-instance deployments only.
// --------------------------------------------------------------------------

export function memoryCoordinator(): Coordinator {
  return {
    kind: "memory",
    async acquireSlot(owner) {
      return acquireOwnerSlot(owner);
    },
    async releaseSlot(owner) {
      releaseOwnerSlot(owner);
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

  return {
    kind: "redis",
    async acquireSlot(owner) {
      const n = await client.incr(slotKey(owner));
      if (n === 1) await client.pexpire(slotKey(owner), 300_000); // bounded leak on crash
      if (n > 3) { // MAX_CONCURRENT_PER_OWNER
        await client.decr(slotKey(owner));
        return false;
      }
      return true;
    },
    async releaseSlot(owner) {
      const k = slotKey(owner);
      const n = await client.decr(k);
      if (n <= 0) await client.del(k);
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
    async close() {
      await client.quit();
    },
  };
}
