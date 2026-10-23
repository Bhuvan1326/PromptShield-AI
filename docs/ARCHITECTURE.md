# Architecture

PromptShield AI is a deterministic AI-security evaluation and defense-verification
workbench. Everything it executes is synthetic; verdicts are always produced by
the deterministic engine, never by a model.

## Layers

```
shared/types.ts            typed contracts (results, findings, sessions, graphs…)
server/engine/             deterministic simulators
  fixtures.ts              10 curated test cases (3 benign, 5 attack, 2 robustness)
  baseline.ts              deliberately vulnerable simulator
  defended.ts              same simulator + controls; delegates tool calls to
                           the firewall policy engine
  harness.ts               executeTest() — runs a fixture, records decisions
  metrics.ts / answers.ts  scoring + ground truth
server/firewall/policy.ts  policy engine: allowlist, arg validation,
                           protected-data rules, single-use approvals,
                           session registry, fail-closed
server/agent/session.ts    autonomous red-team loop (state machine)
server/idempotency.ts      atomic Idempotency-Key reservations (process-local)
server/graph.ts            attack graph/chain builder (observed events only)
server/forensics.ts        per-finding forensic records
server/benchmark.ts        fingerprinted, weighted benchmark scoring
server/ai-eval.ts          Gemini advisory analysis + bounded test planning
server/gemini.ts           SDK wrapper (key server-side only)
server/store.ts            bounded JSON persistence + audit hash chain
server/auth.ts             timing-safe token auth for deployed mode
server/index.ts            Express routes, security headers, rate limits
src/                       React + TS + Vite SPA (10 lazy-loaded views)
```

## Data flow

```
request ─► zod validation ─► [idempotency reserve] ─► rate-limit ─► owner-slot
        ─► session created ─► firewall registerSession
        ─► runAgent lifecycle:
             plan → select(Gemini may nominate; deterministic authoritative)
                  → execute(executeTest → defended→firewall.evaluate)
                  → observe → evaluate → update → repeat/stop
        ─► results → metrics → run + findings + audit (hash-chained)
        ─► graph / forensics / defense-lab / benchmarks consume stored runs
```

## Authority boundaries

- **Deterministic engine** = sole authority for verdicts, budgets, allowed actions.
- **Gemini** = advisory only (analysis, planning, strategy nomination). All outputs
  zod-validated; nominations checked against the catalog allowlist; invalid output
  silently falls back to deterministic planning.
- **Firewall** = the only tool-call gate; unknown tools denied, args validated,
  approvals single-use, fail-closed on engine errors.
- **Idempotency/slots/rate limits** = per-process (documented limitation).
