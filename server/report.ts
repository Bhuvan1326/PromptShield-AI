import type { Finding, RunRecord, SecurityReport } from "../shared/types";
import { ENVIRONMENT_INFO } from "./engine/constants";
import { getTestCase } from "./engine/fixtures";

export const LIMITATIONS = [
  "Both environments are deterministic simulators, not real LLMs. Results demonstrate harness mechanics and guardrail design — they do not measure or predict real model behavior.",
  "The baseline is intentionally vulnerable by construction so the contrast can be demonstrated reproducibly.",
  "Defended checks are pattern-based and can be evaded by novel encodings, paraphrases, multi-turn buildup, or non-English phrasing.",
  "All secrets, identities and tools are synthetic fixtures. No real credentials, systems or data are involved.",
  "Metrics are computed only from executed fixtures in this harness; they are not generalizable security claims.",
];

export const DISCLAIMER =
  "PromptShield AI is a defensive security-testing lab running against isolated, deterministic simulators with synthetic data only.";

export function buildReport(run: RunRecord, findings: Finding[]): SecurityReport {
  return {
    reportVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    tool: "PromptShield AI (deterministic simulation harness)",
    disclaimer: DISCLAIMER,
    project: {
      id: "demo-project",
      name: "PromptShield Demo Lab",
      environment: run.environment,
    },
    run: {
      id: run.id,
      suite: run.suite,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
    testConfiguration: {
      environment: run.environment,
      description: ENVIRONMENT_INFO[run.environment].description,
    },
    results: run.results.map((r) => {
      const test = getTestCase(r.testId);
      return {
        testId: r.testId,
        title: test?.title ?? r.testId,
        category: test?.category ?? "benign",
        label: test?.label ?? "benign",
        expectation: test?.expectation.description ?? "",
        verdict: r.verdict,
        durationMs: r.durationMs,
        evidenceSummary: r.evidence
          .filter((e) => e.kind === "canary_check" || e.kind === "action_check")
          .map((e) => `${e.label}: ${e.content}`),
      };
    }),
    metrics: run.metrics,
    denominators: {
      attackSuccessRate:
        "attack cases scoring 'fail' ÷ all scored attack cases (inconclusive/error excluded)",
      defenseBlockRate:
        "attack cases scoring 'pass' ÷ all scored attack cases (inconclusive/error excluded)",
      benignFalseRefusalRate:
        "benign cases scoring 'fail' (wrongfully blocked) ÷ all scored benign cases",
      precision: "TP ÷ (TP + FP) — of all refusals/blocks, how many were real attacks",
      recall: "TP ÷ (TP + FN) — of all real attacks, how many were neutralized",
      f1: "harmonic mean of precision and recall; null when either is unavailable",
      excluded:
        "robustness ('invalid') cases, inconclusive results and infrastructure errors are excluded from confusion-matrix denominators",
    },
    findings: findings.filter((f) => f.runId === run.id),
    limitations: LIMITATIONS,
  };
}
