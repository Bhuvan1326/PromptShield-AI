import { createHash } from "node:crypto";

/**
 * Idempotency-Key support — PROCESS-LOCAL, in-memory records.
 *
 * Semantics:
 *   - Scoped to (owner, route, key) — one owner can never see or replay
 *     another owner's key.
 *   - 60-second window, bounded map (records swept on access + oldest evicted
 *     past MAX_RECORDS — memory stays bounded).
 *   - Same scope + same request fingerprint → replay the stored session id.
 *   - Same scope + different fingerprint → caller gets 409.
 *   - A record is only written AFTER the session object exists; failures call
 *     abandon() so the key isn't poisoned and a retry can proceed.
 *
 * LIMITATION: records live in this process's memory — they do NOT provide
 * distributed idempotency across multiple server instances. For that, the
 * record store must move to an atomic shared store (e.g. Redis SET NX PX
 * with a Lua check-and-set) — documented, not implemented.
 */

interface IdemRecord {
  fingerprint: string;
  sessionId: string;
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

/** Canonical request fingerprint — key order normalized. */
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

/** Look up a scope key. Returns the record, or null. */
export function lookupIdempotency(scopeKey: string): IdemRecord | null {
  sweep();
  const rec = records.get(scopeKey);
  return rec && rec.expiresAt > Date.now() ? rec : null;
}

/** Record a successful session creation under this key. */
export function recordIdempotency(scopeKey: string, fingerprint: string, sessionId: string) {
  sweep();
  records.set(scopeKey, { fingerprint, sessionId, expiresAt: Date.now() + TTL_MS });
}

/** Drop the record — called when creation failed so retries aren't poisoned. */
export function abandonIdempotency(scopeKey: string) {
  records.delete(scopeKey);
}
