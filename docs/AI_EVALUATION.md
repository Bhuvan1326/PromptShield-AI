# AI Evaluation — Gemini Integration Quality

## Where Gemini is used (advisory only)

| Surface | Function | Contract | Fallback |
|---|---|---|---|
| Run analysis | `analyzeRunWithGemini` | zod `analysisSchema` | throws → UI error state |
| Test planning | `planTestsWithGemini` | zod `planSchema` + **catalog allowlist** | throws → UI error state |
| Agent strategy | `geminiSuggest` (in `runAgent`) | `{strategyId}` + **strategy allowlist** | silent deterministic fallback |
| Finding investigation | `server/gemini.ts` | bounded prompt + sanitize | unavailable state |

Deterministic verdicts/metrics are authoritative everywhere. Model output can
never execute, change verdicts, or nominate anything outside the allowlist.

## Versioned evaluation dataset

`tests/ai-quality.test.ts` — `AI_EVAL_DATASET v1.0.0`, 11 cases across 3
surfaces. What it measures is **the pipeline's handling of model output** —
not the model's reasoning quality:

- valid structured output → accepted, correctly labeled `isAiGenerated`
- hallucinated/unknown ids → dropped into `ignoredTestIds`, never recommended
- injected instruction text in output → ids still allowlist-enforced
- malformed JSON / wrong shape / bad enum → rejected (throws)
- valid strategy nomination → honored + recorded `(gemini)` in trace
- invalid strategy nomination → ignored, `planningSource` stays `deterministic`

Measured properties per run: valid-output rate, schema compliance, policy
compliance (only allowlisted ids survive), fallback correctness. These are
deterministic property assertions — reasoning quality has no single right answer.

## Live verification status

- All tests run with `generateContent` mocked — **no live Gemini call is part
  of the suite**. Live behavior is unverified in CI by design.
- Opt-in live probe: `node scripts/gemini-smoke.mjs` — one bounded 8s call,
  prints only status/latency/result-category, never credentials or prompts.
- Failure-mode coverage (mocked): quota/auth/network/timeout → all three
  advisory surfaces fail closed or fall back deterministic; empty + malformed
  responses rejected; missing key → `GeminiUnavailable` 503 (safe message).
- **Live call record: none performed** — requires an owner-provided key and
  explicit authorization for an external call.
- To verify live end-to-end: set `GEMINI_API_KEY`, run the agent, and watch
  `planningSource: "gemini"` / `(gemini)` trace entries appear.

## Cost/quota handling

- 8s abort timeout per call, `maxOutputTokens` caps (60 for suggest),
  temperature 0.1, one call per agent step (not per fixture), plus explicit
  endpoints only on user action. No retries — failure is a clean fallback.
