import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type express from "express";

/**
 * Operator session auth — server-managed HttpOnly cookie sessions.
 *
 * Design:
 *   - `POST /api/session/login` exchanges PS_API_TOKEN (operator role) or
 *     PS_ADMIN_TOKEN (admin role) for an HttpOnly, SameSite=Strict cookie.
 *     The raw token is never stored client-side, echoed, or logged.
 *   - `x-api-token` header auth remains for API clients/gateways (backward
 *     compatible); cookie auth is the SPA path.
 *   - Cookie auth is ambient → mutations additionally require an origin
 *     guard: `Sec-Fetch-Site` must not be cross-site, and `Origin` (when
 *     present) must match the request Host. SameSite=Strict already blocks
 *     cross-site cookie send; the header checks are defense-in-depth.
 *   - Sessions are process-local (same single-instance limitation as the
 *     rest of the control plane) with 8h TTL and bounded capacity.
 */

export type SessionRole = "operator" | "admin";

interface Session {
  role: SessionRole;
  expiresAt: number;
}

const TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 200;
const sessions = new Map<string, Session>();

export const SESSION_COOKIE = "ps_session";

function sweep() {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.expiresAt <= now) sessions.delete(k);
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [k] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(k);
  }
}

export function createSession(role: SessionRole): string {
  sweep();
  const id = randomBytes(24).toString("hex");
  sessions.set(id, { role, expiresAt: Date.now() + TTL_MS });
  return id;
}

export function getSession(id: string | null | undefined): Session | null {
  if (!id) return null;
  const rec = sessions.get(id);
  if (!rec) return null;
  if (rec.expiresAt <= Date.now()) {
    sessions.delete(id);
    return null;
  }
  return rec;
}

export function destroySession(id: string | null | undefined) {
  if (id) sessions.delete(id);
}

export function readSessionId(req: express.Request): string | null {
  const header = req.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function sessionRole(req: express.Request): SessionRole | null {
  return getSession(readSessionId(req))?.role ?? null;
}

export function sessionCookie(id: string, secure: boolean): string {
  const flags = `HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}`;
  return `${SESSION_COOKIE}=${id}; ${flags}${secure ? "; Secure" : ""}`;
}

export const clearSessionCookie = `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;

/**
 * CSRF origin guard for cookie-authenticated mutating requests. Returns
 * true if the request is safe to proceed. Header-token requests skip this —
 * they aren't ambient so they can't be forged cross-site.
 */
/**
 * Stable ownership principal for resource scoping (slots, idempotency).
 * In deployed mode the owner is derived from the authenticated credential —
 * a session or API token — hashed so session ids/tokens never appear in
 * logs or responses. In local mode it falls back to the request IP.
 * Never trust a client-supplied owner field.
 */
export function ownerOf(req: express.Request): string {
  const sid = readSessionId(req);
  if (getSession(sid)) {
    return `sess:${createHash("sha256").update(sid!).digest("hex").slice(0, 16)}`;
  }
  const token = req.get("x-api-token");
  if (token && process.env.PS_API_TOKEN && safeTokenEqualStr(token)) {
    return `tok:${createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
  }
  return `ip:${req.ip ?? "unknown"}`;
}

/**
 * Object-level authorization: is this request allowed to touch a resource
 * owned by `resourceOwner`?
 *   local mode  → everything is allowed (single trusted user).
 *   deployed    → the authenticated principal must equal the recorded owner,
 *                 or hold an admin session. Resources with no recorded owner
 *                 (legacy data) are admin-only — never silently public.
 */
export function canAccess(req: express.Request, resourceOwner: string | undefined | null): boolean {
  if (!process.env.PS_API_TOKEN) return true; // local mode
  if (sessionRole(req) === "admin") return true;
  if (!resourceOwner) return false;
  return ownerOf(req) === resourceOwner;
}

function safeTokenEqualStr(supplied: string): boolean {
  const expected = process.env.PS_API_TOKEN;
  if (!expected) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function csrfOriginOk(req: express.Request): boolean {
  const fetchSite = req.get("sec-fetch-site");
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
  const origin = req.get("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.get("host")) return false;
    } catch {
      return false;
    }
  }
  return true;
}
