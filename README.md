# PromptShield AI

**Test the attack. Measure the defense.**

A defensive AI security test lab that runs curated, deterministic attack and benign
fixtures against two isolated, simulated assistants:

- **Baseline** — an intentionally vulnerable simulator: no validation, no tool
  authorization, trusted instructions and untrusted input concatenated.
- **Defended** — the same simulator behind deterministic guardrails: input contracts,
  trust separation, injection screening, canary output protection and a strict
  simulated-tool allowlist.

Everything is synthetic. There are no real credentials, tools, systems or data.

## Quick start

```bash
npm install
npm run dev        # API on :8787 + Vite client on :5173 (proxied /api)
```

Open http://localhost:5173.

Production mode:

```bash
npm run build
npm start          # serves API + built client on http://localhost:8787
```

Tests, lint and typecheck:

```bash
npm test           # vitest — unit + API integration tests
npm run lint       # eslint (flat config)
npm run typecheck
```

## Views

| View | What it does |
|------|--------------|
| **Overview** | Posture stats computed from actual runs: attack success rate, block rate, false-refusal rate, latency, environment comparison, failures-by-category chart, recent runs, top findings. |
| **Test Lab** | Pick an environment, run single cases or full/partial suites. Each result opens an evidence drawer: prompt, untrusted content, defense decisions, canary check, action check, sanitized response. |
| **Findings** | Every failed execution becomes a finding (severity, evidence, reproduction steps, remediation). Triage status, rerun, or request an AI investigation summary. |
| **Evaluation** | Per-run confusion matrix, precision/recall/F1, attack success rate, benign false-refusal rate — with denominators, definitions, exclusion rules, JSON report export and a copyable executive summary. |
| **Audit** | Timestamped trail of runs, executions, findings, exports, investigations and resets. One-click reset (double-confirm). |

## Test fixtures

10 deterministic cases in `server/engine/fixtures.ts`: 3 benign (including a
canary-topic false-refusal probe), 5 attacks (direct injection, indirect injection in
quoted untrusted text, synthetic-canary extraction, forbidden simulated tool,
obfuscated injection) and 2 robustness cases (malformed input, oversized input).

## Metrics

Positive class = attack. `TP` = attack neutralized, `FN` = attack succeeded,
`TN` = benign answered, `FP` = benign refused (false refusal). Robustness,
inconclusive and error results are counted but excluded from confusion-matrix
denominators. All rates return `null` on a zero denominator (rendered as `n/a`).

## Gemini integration (optional)

AI investigation summaries are optional and server-side only.

1. `cp .env.example .env`
2. Set `GEMINI_API_KEY=<your key>` (get one at https://aistudio.google.com/apikey)
3. Restart the server.

The key is read only by the backend (`process.env`), never sent to the browser,
never logged, never persisted. Prompts contain only sanitized evidence (canary
redacted, hard truncation, 12s timeout, safe errors). Model output is treated as
untrusted text — displayed, never executed. Without a key the app runs fully in
deterministic mode and the sidebar shows "Gemini not configured".

## Architecture

```
shared/types.ts      typed API contracts
shared/metrics.ts    verdict scoring + metric computation (pure, unit-tested)
server/engine/       constants, fixtures, baseline sim, defended sim, harness
server/store.ts      JSON file persistence (server/data/promptshield.json)
server/findings.ts   failed results → findings
server/stats.ts      overview aggregation
server/report.ts     exportable security report
server/gemini.ts     optional Gemini investigation (key never leaves server)
server/index.ts      Express API (zod-validated)
src/                 React + TS + Vite + Tailwind dashboard (5 views)
tests/               vitest unit tests
```

## Security model

- No real tool execution — "actions" are simulated strings checked against an
  allowlist. No shell, filesystem, network or URL-fetching capabilities exist.
- The synthetic canary is redacted in all stored evidence, logs and responses.
- Server inputs are validated with zod; request bodies capped at 100 KB.
- Baseline weakness is explicit, isolated and disclosed in the UI.
- Security headers on every response: CSP, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`.
- Rate limiting: `/api/investigate` 5/min, `/api/runs` 30/min, `/api/reset`
  5/hour (HTTP 429 + `Retry-After`). **Per-process, in-memory** — suitable for
  a single instance only; not a distributed limit.
- `POST /api/reset` requires `{"confirm":"RESET"}`. This is an accident guard,
  **not authentication** — behind any non-local deployment it needs real
  access control.
- `/api/health/status` reports component state only — no filesystem paths.
- Metrics never silently classify unknown test IDs; they are excluded and
  counted separately (`unknownTestIds`).
- Corrupt storage is quarantined and logged (without contents) instead of
  silently discarded.
- Gemini calls carry an `AbortSignal` timeout that cancels the underlying
  request rather than just abandoning it.

## Threat model & limitations

- Both environments are **deterministic simulators, not LLMs**. Results
  demonstrate harness mechanics and guardrail design; they do not measure or
  predict real model behavior.
- The baseline is vulnerable *by construction* so the contrast is reproducible.
- Defended checks are pattern-based and can be evaded by encodings, paraphrases,
  multi-turn buildup or non-English phrasing — it is not complete protection.
- Metrics describe this fixture suite only; they are not generalizable claims.
- Persistence is a local JSON file — suitable for a demo/hackathon, not multi-user
  production.

## Test results

`npm test` → **50/50 passing**: 29 engine/metric unit tests + 17 API
integration tests (validation, redaction, rerun, report, rate limiting, reset
confirmation, header checks) + 4 metrics regression tests (unknown test IDs,
empty/degenerate denominators). API tests run against an isolated temp data
file and never touch developer data or the real Gemini API.

## Known dependency residuals (audit, 2026-10-23)

`npm audit --omit=dev` → 2 moderate (react-router 6.x advisories requiring the
v7 major; the affected patterns — SSR hydration, navigation to
attacker-controlled URLs — are not used by this app).

Full `npm audit` → 21 remaining, all in **dev-tooling** chains: vitest/tinypool
(critical, needs vitest ≥3), vite/esbuild (needs vite ≥6.4.4), tailwindcss v3
chains (needs v4 major), typescript-eslint transitive micromatch/braces.
These affect build/test tooling only and process no untrusted input; the
major upgrades were deferred as breaking changes.
