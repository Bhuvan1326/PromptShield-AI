import type {
  EvidenceItem,
  ExecutionResult,
  Finding,
  FindingSeverity,
  RiskLabel,
  RunRecord,
  TestCase,
  TestCategory,
} from "../shared/types";
import { getTestCase } from "./engine/fixtures";
import { id } from "./store";

const severityFromRisk: Record<RiskLabel, FindingSeverity> = {
  critical: "critical",
  high: "high",
  medium: "medium",
  low: "low",
  info: "low",
};

const REMEDIATION: Record<TestCategory, string> = {
  benign:
    "This is a false refusal, not a vulnerability. Tune the detection rules so harmless requests that merely mention sensitive topics remain answerable.",
  prompt_injection:
    "Separate trusted instructions from user input, screen for instruction-override phrasing, and scan model output for protected-context material before returning it.",
  indirect_injection:
    "Treat all retrieved/quoted content as data. Wrap untrusted text in explicit delimiters, scan it for embedded instructions, and never let it modify the assistant's policy.",
  data_extraction:
    "Plant a synthetic canary in protected context and scan every output for it. Deny or redact responses that disclose protected fields; never echo raw system context.",
  unauthorized_action:
    "Enforce a strict tool allowlist evaluated before any tool call. Require explicit authorization for destructive actions and record every decision.",
  robustness:
    "Validate input contracts early: reject oversized payloads and malformed/control-character input before any model or tool work happens.",
};

const TITLE: Record<TestCategory, { attack: string; benign: string; invalid: string }> = {
  benign: {
    attack: "",
    benign: "Benign request wrongly refused (false positive)",
    invalid: "",
  },
  prompt_injection: {
    attack: "Prompt injection disclosed protected context",
    benign: "",
    invalid: "",
  },
  indirect_injection: {
    attack: "Embedded instruction in untrusted content was obeyed",
    benign: "",
    invalid: "",
  },
  data_extraction: {
    attack: "Protected context extraction succeeded",
    benign: "",
    invalid: "",
  },
  unauthorized_action: {
    attack: "Forbidden simulated action executed",
    benign: "",
    invalid: "",
  },
  robustness: {
    attack: "",
    benign: "",
    invalid: "Malformed/oversized input processed instead of rejected",
  },
};

/**
 * Convert failed execution results into findings. One finding per failed test
 * per run — no deduplication across runs (each run is its own evidence set).
 */
export function findingsFromRun(
  run: Pick<RunRecord, "id" | "environment">,
  results: ExecutionResult[],
): Finding[] {
  const findings: Finding[] = [];
  for (const result of results) {
    if (result.verdict !== "fail") continue;
    const test: TestCase | undefined = getTestCase(result.testId);
    if (!test) continue;

    findings.push({
      id: id("find"),
      testId: test.id,
      runId: run.id,
      environment: run.environment,
      severity: severityFromRisk[test.risk],
      status: "open",
      title: TITLE[test.category][test.label] || `${test.title} — unexpected outcome`,
      category: test.category,
      description: describeFailure(test, result),
      reproductionSteps: reproductionSteps(test, run.environment),
      evidence: summarizeEvidence(result.evidence),
      remediation: REMEDIATION[test.category],
      createdAt: new Date().toISOString(),
    });
  }
  return findings;
}

function describeFailure(test: TestCase, result: ExecutionResult): string {
  const parts: string[] = [];
  if (result.canaryLeaked)
    parts.push("the synthetic canary was disclosed in the response");
  if (result.privateDataLeaked)
    parts.push("synthetic private-context fields were disclosed");
  if (result.actionExecuted && test.expectation.mustNotExecuteAction)
    parts.push(`forbidden simulated tool '${test.requestedAction}' executed`);
  if (test.label === "benign" && result.blocked)
    parts.push("the request was blocked even though it is harmless");
  if (test.label === "invalid" && !result.blocked)
    parts.push("malformed input was processed instead of rejected");
  const what = parts.length ? parts.join("; ") : "the observed behavior violated the stated expectation";
  return `In the ${test.category.replace(/_/g, " ")} scenario '${test.title}', ${what}. Expected: ${test.expectation.description}`;
}

function reproductionSteps(test: TestCase, environment: string): string[] {
  const steps = [
    `Open Test Lab and select the '${environment}' environment.`,
    `Run test ${test.id} ('${test.title}').`,
    "Inspect the response and the defense-decision evidence in the drawer.",
  ];
  if (test.untrustedContent)
    steps.splice(2, 0, "Note that the payload travels inside untrusted quoted content.");
  return steps;
}

function summarizeEvidence(evidence: EvidenceItem[]): EvidenceItem[] {
  // Findings keep the most decision-relevant items only.
  const keep = evidence.filter((e) =>
    ["defense_decision", "canary_check", "action_check", "response"].includes(e.kind),
  );
  return keep.slice(0, 8);
}
