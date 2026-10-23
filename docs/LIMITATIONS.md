# Limitations — stated honestly

## Security

- **Unresolved Critical**: a likely-real credential exists in commit `166dee4`
  reachable via local branch `backup-before-secret-cleanup`. Rotation and
  history purge are **user actions** — intentionally not performed by tooling.
- Owner identity is `req.ip` — client-derived, not authenticated. Correct for
  a single-trusted-user demo; not multi-tenant.
- Slots, idempotency, and rate limits are **process-local**. Multi-instance
  deployment requires a shared atomic store (e.g. Redis `SET NX PX`) — designed
  for, not implemented.
- JSON persistence is rewrite-per-mutation (atomic tmp+rename) — bounded and
  crash-safe per write, but not transactional across entities and last-write-wins
  across concurrent processes.
- Audit hash chain detects post-hoc modification of stored events; it does not
  prove events true or prevent a rewrite-before-seal attack on a live file.

## Correctness scope

- All test execution is **deterministic simulation**. Fixture ASR/block rates
  are evidence about these fixtures only — not universal real-world protection.
- The agent adapts strategy **within an approved catalog** (escalation chains,
  outcome-scored selection). It does not synthesize novel attack types — that
  is described accurately, not claimed.
- Attack-graph "inferred" edges are temporal adjacency, labeled as inference.
- Defense-lab regressions require aligned runs (same suite/tests); missing
  results are reported, not assumed.
- Benchmark scores are deterministic-fixture-only; no live-model variance.

## Verification gaps (explicit)

- Live Gemini path not exercised in CI (all mocked by design; opt-in
  `scripts/gemini-smoke.mjs` exists for owner-authorized live verification —
  no live call has been performed or recorded).
- Screen-reader verification, real color-contrast measurement (axe can't
  evaluate layout/color in jsdom), and a full keyboard pass on every view are
  **manual checks pending** — itemized in `docs/A11Y_MANUAL.md`.
- No sustained load test; perf numbers are local single-run measurements.
- Dev-tooling advisories (21 incl. 2 critical) unresolved pending major upgrades.

## Product gaps

- No component-level unit tests for the five new views (a11y route scans +
  API coverage exist).
- Sessions left `running` if the process dies mid-run (in-memory lifecycle).
- Agent cancellation is cooperative (honored at step boundaries, not mid-call).
