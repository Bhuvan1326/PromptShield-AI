import { createHash } from "node:crypto";

/**
 * Idempotency-Key support — PROCESS-LOCAL, in-memory records with an
 * atomic reservation state machine.
 *
 * Semantics:
 *   - Scoped to (owner, route, key) — one owner can never see or replay
 *     another owner's key.
 *   - 60-second window, bounded map (records swept on access + oldest evicted
 *     past MAX_RECORDS — memory stays bounded).
 *   - reserve() is a single synchronous check-and-set: it either replays an
 *     existing record, reports a fingerprint conflict, or atomically takes
 *     the slot in 'in_flight' state carrying the pre-allocated sessionId —
 *     so concurrent identical requests all converge on ONE session id even
 *     while creation is still in flight.
 *   - finalize() marks the record stored; abandon() drops it so failures
 *     never poison a key (a retry can proceed).
 *   - Same scope + different fingerprint → 409.
 *
 * LIMITATION: records live in this process's memory — they do NOT provide
 * distributed idempotency across multiple server instances. That requires
 * an atomic shared store (e.g. Redis `SET NX PX` with a Lua compare-and-
 * finalize, or a DB unique-constraint upsert) — documented, not implemented.
 */

type IdemState = "in_flight" | "stored";

interface IdemRecord {
  fingerprint: string;
  sessionId: string;
  state: IdemState;
  expiresAt: number;
}

const TTL_MS = 60_000;
const MAX_RECORDS = 500;
const records = new Map<string, IdemRecord>();

/** Valid key format: 8-128 chars, URL-safe. */
export const IDEM_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function idemScope(owner: string, route: string, key: string): string {
  return `${owner}|${route}|${key}`;
}

/** Canonical request fingerprint — key order normalized; arrays keep order. */
export function requestFingerprint(body: unknown): string {
  const canon = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, canon((v as Record<string, unknown>)[k])]),
        )
      : v;
  return createHash("sha256").update(JSON.stringify(canon(body))).digest("hex");
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of records) if (v.expiresAt <= now) records.delete(k);
  if (records.size > MAX_RECORDS) {
    const oldest = [...records.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [k] of oldest.slice(0, records.size - MAX_RECORDS)) records.delete(k);
  }
}

export type ReserveResult =
  | { kind: "reserved" }
  | { kind: "replay"; sessionId: string }
  | { kind: "conflict" };

/**
 * Atomic check-and-set. Call with the sessionId BEFORE creation begins:
 *   - "reserved" → caller owns the reservation; must finalize() on success or
 *     abandon() on failure.
 *   - "replay"   → a record already exists (stored or in-flight); return its
 *     sessionId — do not create anything.
 *   - "conflict" → same key, different request fingerprint → 409.
 */
export function reserveIdempotency(
  scopeKey: string,
  fingerprint: string,
  sessionId: string,
): ReserveResult {
  sweep();
  const rec = records.get(scopeKey);
  if (rec && rec.expiresAt > Date.now()) {
    return rec.fingerprint === fingerprint
      ? { kind: "replay", sessionId: rec.sessionId }
      : { kind: "conflict" };
  }
  records.set(scopeKey, {
    fingerprint,
    sessionId,
    state: "in_flight",
    expiresAt: Date.now() + TTL_MS,
  });
  return { kind: "reserved" };
}

/** Mark a reservation's session as durably created. */
export function finalizeIdempotency(scopeKey: string) {
  const rec = records.get(scopeKey);
  if (rec) rec.state = "stored";
}

/** Drop the record — called on failure so retries aren't poisoned. */
export function abandonIdempotency(scopeKey: string) {
  records.delete(scopeKey);
}
