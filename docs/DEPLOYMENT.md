# Deployment — Vercel (frontend) + Render (API)

## Topology

```
Browser ──https──► Vercel (static SPA, dist/)
                    └─ /api/* ──rewrite──► Render (Express :8787)
```

`vercel.json` proxies **all** `/api/*` to the Render instance — the SPA and API
are same-origin from the browser's perspective, so cookies work without CORS.

## Render service

| Setting | Value |
|---|---|
| Build | `npm ci && npm run build` |
| Start | `npx tsx server/index.ts` (or compile + node) |
| Health | `GET /api/health/status` → `engine.state==="ready"` |

## Environment variables (Render — secrets live HERE only)

| Var | Required | Purpose |
|---|---|---|
| `PS_API_TOKEN` | deployed mode | operator credential (login + `x-api-token` header) |
| `PS_ADMIN_TOKEN` | recommended | admin/reset credential (admin session) |
| `PS_AUDIT_SIGNING_KEY` | recommended | HMAC key for signed audit events + checkpoints — **never the same as the data file** |
| `GEMINI_API_KEY` | optional | advisory AI surfaces |
| `PS_COORDINATION` | optional | `redis` for multi-instance (requires `PS_REDIS_URL`) |
| `PS_REDIS_URL` | with redis | `redis://…` — slots + idempotency shared store |
| `PROMPTSHIELD_DB_PATH` | optional | data file location (persistent disk mount recommended) |
| `NODE_ENV=production` | yes | enables Secure cookies + prod auth warning |

**Never** put any of these in `VITE_*` vars — the SPA must stay secret-free.

## Cookie/session behavior through the rewrite

- `ps_session` is `HttpOnly; SameSite=Strict; Path=/` (+ `Secure` in prod).
- SameSite=Strict + Vercel proxy = cookie only flows to the app's own origin —
  cross-site POSTs can't send it. CSRF origin guard adds defense-in-depth.
- Sessions are process-local — a Render redeploy clears them (re-login needed).

## Verified behaviors (tests + live smoke)

- Unauthenticated mutation in deployed mode → 401; forged Origin/sec-fetch-site
  on cookie auth → 403; operator session cannot `/api/reset` (admin only).
- `trust proxy` is **off** — owner scoping uses the real connection IP; under
  Render's edge proxy this is the edge IP (documented limitation).
- Graceful handling: JSON store uses atomic tmp+rename; `store.batch` flushes
  related mutations atomically; stale `running` sessions recover to
  `error:"process_exit"` on load.

## Multi-instance (optional, requires Redis)

Set `PS_COORDINATION=redis` + `PS_REDIS_URL`. Coordination moves to shared
atomic primitives:

- **Owner slots** → lease semaphore in a Redis ZSET (`leaseId:deadline`
  members, Lua: prune-expired + capacity-check + insert in ONE atomic eval).
  Expired leases auto-free; releases are exact-member removes — a stale
  worker can never drop a newer lease. `runAgent` checks `leaseValid` at
  each step boundary — a lost lease stops protected work (`lease_lost`).
  Lease TTL = `budget.maxMs + 30s` — expiry strictly after the worker's
  own deadline, so a healthy run never loses authority.
- **Idempotency** → `SET NX PX` reserve + Lua compare-finalize/abandon;
  owner+route+key scoped, replay/conflict/in-flight states.
- **Rate limits** → atomic `INCR`+`PEXPIRE` fixed-window shared across
  instances; backend failure **fails closed** (503) — never degrades to
  per-process counters in redis mode.

If Redis is unreachable at startup the process **fails closed** (refuses to
start). Sessions and JSON persistence remain single-host — true horizontal
scaling still needs shared sessions + durable storage (PostgreSQL).

| `PS_AUDIT_SIGNING_KEYS` | rotation map `{"v1":"…","v2":"…"}` (JSON) |
| `PS_AUDIT_SIGNING_KID` | active signing key id |

## Smoke checklist after deploy

1. `GET /api/health/status` → `engine.state:"ready"`, `auth.mode:"deployed"`.
2. `POST /api/session/login` {token} → Set-Cookie + `{authenticated:true}`.
3. A mutation without auth → 401; forged `Origin` → 403.
4. `GET /api/audit/verify` → `{valid:true}` (+`signed:true` if key set).
5. `scripts/secret-scan.mjs` → clean.
