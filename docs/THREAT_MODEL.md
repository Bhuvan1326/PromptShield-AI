# Threat Model

Scope: local/hackathon deployment of an isolated, synthetic AI-security lab.
There are no real tools, targets, credentials or data. This model covers the
application itself, not the simulated scenarios.

## Assets

- Integrity of verdicts, metrics, findings and audit trail.
- The stored canary value and Gemini API key (server-side).
- Availability under agent/benchmark workloads.

## Trust boundaries

| Boundary | Control |
|---|---|
| Client → API | zod schemas on every mutation; 200KB body limit; security headers/CSP; per-scope rate limits; `trust proxy` OFF; deployed auth: `x-api-token` header **or** HttpOnly SameSite=Strict session cookie (operator/admin roles); CSRF origin guard on cookie-authed mutations |
| Route → agent | `runAgent` owns concurrency slots (single acquire/release); owner = `req.ip`; cap 3/owner; budgets enforced server-side; dedicated `agent` rate-limit scope |
| Agent → fixtures | approved catalog only; no arbitrary code, network, or filesystem |
| Model → pipeline | zod + allowlist validation; advisory only; abort timeouts; key never client-side |
| Events → audit | SHA-256 hash chain; tamper-evident within retained window |
| Requests → storage | bounded retention caps; atomic tmp-write + rename |

## Verified controls (with evidence)

- Owner-slot lifecycle: exactly-once release across completion/cancel/exception/cap-reject — unit-tested (platform.test.ts) + live load smoke (3/10 concurrent 202, rest 429, no leak).
- Idempotency: atomic reserve→finalize/abandon; concurrent duplicates → one session, one audit event, `Idempotency-Replayed` header — API-tested.
- Firewall: deny-unknown, arg validation, approval-required, session guard, fail-closed — unit + API tested.
- Redaction: canary value never serializes into findings/forensics/HTML — tested.
- Audit chain: verifies (`/api/audit/verify`); tampering detected — tested.
- Auth: `PS_API_TOKEN`/`PS_ADMIN_TOKEN` timing-safe compare; SPA authenticates via `POST /api/session/login` → HttpOnly `ps_session` cookie (8h TTL, admin vs operator role); CSRF blocked for forged Origin/`sec-fetch-site`; logout invalidates; admin session required for `/api/reset` — all covered by 5 e2e tests.

## Known residual risks (unresolved)

| Risk | Severity | Status |
|---|---|---|
| Credential committed in `166dee4` reachable on local `backup-before-secret-cleanup` | Critical | **USER ACTION** — rotate + purge; intentionally untouched |
| Owner identity = `req.ip` (not authenticated) | Medium | documented; fine for single-trusted-user demo, not multi-tenant |
| Per-process slots/idempotency/rate-limits | Medium | documented; multi-instance needs shared atomic store (e.g. Redis SET NX PX) |
| JSON rewrite-per-mutation persistence | Medium | bounded retention + atomic rename; not transactional — last-write-wins across concurrent processes |
| Dev-tooling advisories (21 incl. 2 critical) | Medium | majors required (vite/vitest/react-router); deferred — documented |
| `report_exported` audit on GET report endpoints | Low | intentional export logging |
| Sessions persisted `running` after a process crash | Low | **mitigated** — load-time sweep marks them `error:"process_exit"` (tested) |

## Out of scope / non-goals

- Real-world attack efficacy of fixture results (explicitly disclaimed).
- Universal protection claims — benchmark scores are deterministic-fixture only.
- Distributed idempotency, cross-instance concurrency, durable audit store.
