# Benchmark Methodology

## What a benchmark measures

`POST /api/benchmarks/run` executes a declared suite of fixtures through the
deterministic engine and scores the result. It measures **defense behavior on
this fixed synthetic catalog** — nothing more.

## Reproducibility metadata (stored per run)

- `fingerprint` — SHA-256 over suite id + ordered test ids + environment +
  fixture version + evaluator version. Identical fingerprints mean identical
  deterministic results.
- `reproducible` — `"exact"` for deterministic runs (all current suites).
  Anything involving a live model would be labeled approximate — none exists today.
- config, environment, timestamps, weights used.

## Scoring (transparent, deterministic)

`score = weighted mean` over per-metric components (weights configurable, defaults
equal). Components with a **null denominator are excluded and weights are
renormalized** — the score never fabricates a value for unmeasured metrics.
The formula and weights are returned by `GET /api/benchmarks` and shown in the UI.

Honesty rules enforced in code:

- Missing results are counted and reported — never silently scored as blocked.
- `sameConfiguration` is computed in compare; identical fingerprints are flagged
  rather than presenting a fake "difference".
- No leaderboards, no external rankings, no universal-protection claims.

## Measured local performance (2026-06, Windows dev box, Node 24, deterministic mode)

Method: `scripts/perf.mjs`, warmup excluded, 60 sequential samples per endpoint
(p50/p95/p99 of client-observed latency). Local measurements, not guarantees.

| Operation | n | p50 | p95 | p99 |
|---|---|---|---|---|
| `POST /api/firewall/evaluate` | 60 | 5.1 ms | 6.7 ms | 22.4 ms |
| `GET /api/health/status` | 60 | 0.4 ms | 0.7 ms | 1.0 ms |
| `POST /api/runs` (10 tests + persist) | 8 | 83 ms | — | 95.8 ms max |
| Agent quick session (baseline, 4 steps) | 1 | 136 ms end-to-end, 18 trace events | | |

Memory (measurement host): RSS 68 MB. Frontend bundle: entry 187 KB gzipped 60 KB,
all 10 views lazy-loaded.

Dominant cost: `POST /api/runs` = full-suite execution + synchronous JSON
rewrite — persistence is the known bottleneck at scale (documented in
THREAT_MODEL / LIMITATIONS).

Reproduce:

```bash
DOTENV_CONFIG_PATH=/dev/null PS_AGENT_STEP_DELAY_MS=10 PS_RL_RUNS_MAX=500 PS_RL_WINDOW_MS=1000 npx tsx server/index.ts &
node scripts/perf.mjs
```
