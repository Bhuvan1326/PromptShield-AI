import { createHash, timingSafeEqual } from "node:crypto";
import type express from "express";
import { csrfOriginOk, sessionRole } from "./session";

/**
 * Constant-time token comparison that also tolerates unequal-length inputs:
 * both sides are SHA-256 digested first, so no length or early-exit timing
 * signal leaks and timingSafeEqual never throws on mismatched lengths.
 */
export function safeTokenEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

/**
 * Deployment gate for mutating or quota-consuming endpoints.
 *
 * Deployment model (explicit):
 *   - PS_API_TOKEN unset  → LOCAL DEMO MODE. Mutating endpoints are open to
 *     whoever can reach the process. Intended for single-user localhost and
 *     the hackathon demo. Not a security boundary.
 *   - PS_API_TOKEN set    → DEPLOYED MODE. Callers must present the token in
 *     the `x-api-token` header; anything else gets 401. The token is compared
 *     in constant time and never returned to clients or logged.
 *
 * IP rate limiting is deliberately NOT treated as authentication.
 * The frontend SPA is a local-demo client; in deployed mode callers must
 * inject the header outside the bundled UI (gateway, extension, or API
 * client) — shipping the token to the browser would defeat the control.
 */
export function requireApiToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const expected = process.env.PS_API_TOKEN;
  if (!expected) return next(); // local demo mode
  const supplied = req.get("x-api-token") ?? "";
  if (supplied && safeTokenEqual(supplied, expected)) return next();
  // Cookie-session path (SPA): ambient credentials need an origin guard.
  const role = sessionRole(req);
  if (role) {
    if (!csrfOriginOk(req)) {
      return res.status(403).json({ error: "Cross-origin mutation rejected." });
    }
    return next();
  }
  return res.status(401).json({ error: "Authentication required." });
}
