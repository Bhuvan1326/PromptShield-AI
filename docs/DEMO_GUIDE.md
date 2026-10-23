# Demo Guide — one complete security investigation

Discover → Explain → Defend → Verify → Report, in ~6 minutes.

## Setup

```bash
npm install
npm run dev        # API :8787 + client :5173 — open http://localhost:5173
```

Deterministic mode needs no keys. Optional: `GEMINI_API_KEY` in `.env` enables
advisory AI features (labeled "AI-generated" everywhere).

## 1. Show the vulnerable baseline (Discover)

- **Test Lab** → environment `baseline` → run **Full suite**.
- Open a failing result (e.g. PS-INJ-01) — the evidence drawer shows the prompt,
  untrusted input, canary leak check, and sanitized response.
- **Findings** — each verified failure has severity + reproduction steps.

## 2. Show the autonomous agent (Explain)

- **Red Team** → `baseline`, preset `standard` → **Start agent**.
- Watch the trace: `plan → select → execute → observe → evaluate` per step.
- The agent **adapts**: a successful injection escalates the next selection
  toward canary-extraction / unauthorized-action strategies (shown in the
  trace); repeated blocks de-prioritize. Budget meter + stop control.
- With a Gemini key, a `(gemini)` tag appears on select steps where the model
  nominated a strategy — deterministic scoring remains authoritative.

## 3. Show the attack graph (Explain)

- **Attack Graph** → pick the agent run — observed nodes/edges only; verified
  chains listed (inferred edges are dashed + labeled).
- Click a node (mouse) or use the **All nodes** list (keyboard) → Node detail
  shows type, evidence refs, outcome. Filter by type/outcome.

## 4. Show the defended environment (Defend)

- **Test Lab** → environment `defended` → run **Full suite**.
- Evidence drawers now show firewall decisions (`firewall.*` ruleIds) instead
  of raw `action.allowlist`.
- **Firewall** view → evaluate `export_report` → `approval_required`; mint an
  approval → re-evaluate → `allow`. Try an unknown tool → `deny` (R1).

## 5. Compare (Verify)

- **Defense Lab** → select the baseline run (A) and defended run (B) →
  per-test verdict table + metric deltas. Regressions are flagged
  (pass→fail), missing results counted honestly.

## 6. Forensics + report (Report)

- **Findings** → open a finding → forensic record: trace ID, timeline,
  decisions, root cause, remediation + regression test, replay eligibility.
- **Evaluation** → run → **Export report** (JSON) or `GET /api/runs/:id/report.html`
  for a sanitized, print-ready report.
- **Audit** → `GET /api/audit/verify` — hash-chain integrity check.

## 7. Optional — benchmark reproducibility

- **Benchmarks** → run `full` on baseline and defended → compare shows deltas
  + `sameConfiguration` flag + fingerprints.

## Backup path

If the live UI is unavailable, the whole story is API-reproducible:

```bash
curl -X POST localhost:8787/api/agent/sessions -d '{"environment":"baseline","preset":"quick"}' -H "Content-Type: application/json"
curl localhost:8787/api/runs/{runId}/graph
curl localhost:8787/api/audit/verify
```

Reset between demos: **Audit** → reset (double-confirm), or
`POST /api/reset` (admin token in deployed mode).
