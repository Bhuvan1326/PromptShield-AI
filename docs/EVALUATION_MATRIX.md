# Evaluation Matrix — criterion-by-criterion readiness

No official rubric weights were available, so this matrix maps each criterion to
evidence rather than manufacturing a score. Statuses are verified against the
actual codebase, not aspirations.

Legend: ✅ verified · ⚠️ partial/unverified · ❌ gap

## 1. Code Quality — ✅

| Aspect | Evidence | Location |
|---|---|---|
| Strict typing, 0 errors | `npx tsc --noEmit` clean | `tsconfig` strict |
| Lint clean | `eslint` 0 problems | flat config |
| Layered architecture | shared → engine → policy/agent → store → routes → views | `docs/ARCHITECTURE.md` |
| Typed API contracts | zod on all mutation endpoints | `server/index.ts` |
| Explicit invariants | owner-slot lifecycle, idempotency reservation, hash chain | module docstrings |
| Lazy loading | 10 views code-split | `src/App.tsx` |

## 2. Security — ✅ with disclosed blockers

| Control | Evidence |
|---|---|
| Firewall enforcement | `evaluate()` used by defended engine + API console; deny/validate/approve/fail-closed tested |
| Owner-slot lifecycle | exactly-once release across all exits — unit + live-tested |
| Idempotency | atomic reserve/finalize/abandon — concurrent-duplicate tested |
| Auth (deployed) | `x-api-token` header OR HttpOnly SameSite=Strict session cookie (`POST /api/session/login`); CSRF origin guard; admin role for reset; timing-safe compares; 5 e2e tests (bad token, cookie auth, forged Origin/sec-fetch-site, forged/expired/logged-out session, admin-vs-operator) |
| Redaction | canary never serializes — tested |
| Audit integrity | SHA-256 chain, tamper detection tested, `/api/audit/verify` |
| Validation/headers/limits | zod, CSP, per-scope rate limits — API-tested |
| **Blocker** | `166dee4` credential — user action required (THREAT_MODEL) |
| Dev deps | 21 advisories incl. 2 critical — majors deferred (documented) |

## 3. Efficiency — ✅ measured

See `docs/BENCHMARK_METHODOLOGY.md`: firewall eval p50=5.1ms, runs p50=83ms,
agent quick=136ms; lazy bundles; bounded persistence/retention; per-owner
concurrency; honest small-sample caveat stated.

## 4. Testing — ✅

| Suite | Tests |
|---|---|
| Engine/harness | 16 |
| Metrics (edge cases) | 19 |
| API integration | 34 |
| Gemini (mocked) | 6 |
| AI-eval pipeline | 8 |
| Platform units (firewall/agent/graph/forensics/benchmark) | 21 |
| AI output quality (dataset v1.0.0) + Gemini failure modes | 7 |
| Accessibility (axe+jsdom) | 12 |
| **Total** | **124** (re-run `npm test` for the current number) |

Gaps: no component-level unit tests for new views, no e2e driver, no sustained
load test — disclosed in LIMITATIONS.

## 5. Accessibility — ⚠️

- axe-core scans: shell + all 5 new views (populated states) — 0 violations.
- Keyboard node list (AttackGraph), labeled forms (Firewall/DefenseLab/
  Benchmark), compact `role="status"` announcements (agent steps, newest
  firewall decision — fixed announcement-flooding), `role=progressbar`.
- Manual checklist with per-item status: `docs/A11Y_MANUAL.md`.
- Pending manual: screen reader, real contrast, full keyboard pass — disclosed.

## 6. Problem-statement alignment — ✅

Original app; the demo loop (Discover→Explain→Defend→Verify→Report) is real:
autonomous adaptive agent, observed-event graph, defense comparison, forensics,
benchmarks, runtime firewall — with deterministic authority and honest
limitations. See `docs/DEMO_GUIDE.md`.

## 7. Google services — ⚠️ verified pipeline, unverified live

Real `@google/genai` SDK integration on 4 surfaces (analysis, planning, agent
nomination, investigation) — all advisory, schema-gated, allowlist-enforced,
timeout-bounded, fallback-covered. Live call NOT verified in CI (mocked by
design); live-verification procedure documented in `docs/AI_EVALUATION.md`.
No unrelated Google services added.

## Submission checklist

- [ ] Rotate + purge `166dee4` credential (user action — blocker).
- [ ] Run `npm run lint && npx tsc --noEmit && npm test && npm run build`.
- [ ] Record the demo per `docs/DEMO_GUIDE.md` (with Gemini key if demoing AI).
- [ ] One live Gemini verification run (optional but recommended).
- [ ] Manual a11y pass (screen reader + keyboard) — document honestly.
- [ ] Commit this working tree (currently uncommitted changes exist).
