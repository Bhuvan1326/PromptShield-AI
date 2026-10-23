import type {
  ForensicRecord,
  Finding,
  RunRecord,
  TestCase,
} from "../shared/types";
import { sanitize } from "./engine/harness";
import { ENVIRONMENT_INFO } from "./engine/constants";
import { store } from "./store";

/**
 * AI SECURITY FORENSICS — structured forensic records assembled from stored
 * run/finding/audit data. Everything is sanitized on the way in; the record
 * cites evidence by reference rather than duplicating raw payloads.
 */

const ROOT_CAUSE: Record<string, { rootCause: string; control: string; change: string; test: string }> = {
  prompt_injection: {
    rootCause: "Trusted instructions and untrusted input share one channel — attacker text reached the instruction layer.",
    control: "Untrusted-input isolation + instruction-boundary enforcement",
    change: "Route user/untrusted content through a data channel; reject override markers before synthesis (see defended.ts screening).",
    test: "Replay the same fixture on 'defended' — expect verdict pass with rule injection.override_marker.",
  },
  canary_extraction: {
    rootCause: "No output screening for planted markers — protected context flowed to the response channel.",
    control: "Canary/protected-marker output filter",
    change: "Scan synthesized output for the canary value + protected markers; redact and record a decision (output.canary_screen).",
    test: "Assert response does not contain the canary value on defended replay.",
  },
  unauthorized_action: {
    rootCause: "Action requests reach execution without a policy check — no allowlist or argument validation.",
    control: "Runtime firewall: tool allowlist + argument validation + approval for sensitive actions",
    change: "Evaluate every tool call through firewall evaluate() before execution; deny unknown tools by default.",
    test: "Replay action fixture; expect firewall.* deny decision and no actionExecuted.",
  },
  robustness: {
    rootCause: "Input contract violated (control chars, oversized payload) without rejection or bounded handling.",
    control: "Input-contract validation with explicit limits",
    change: "Reject control characters and payloads over MAX_*_CHARS with an explicit error outcome.",
    test: "Re-send the malformed input on defended — expect a bounded error response.",
  },
};

export function buildForensicRecord(finding: Finding, run: RunRecord, test: TestCase): ForensicRecord {
  const result = run.results.find((r) => r.testId === finding.testId);
  const rc = ROOT_CAUSE[finding.category] ?? {
    rootCause: "Security-relevant behavior observed.",
    control: "Policy enforcement at the input/tool/output boundary",
    change: "Add an explicit policy decision for this category.",
    test: "Replay the fixture on defended and assert pass.",
  };

  // Timeline: audit events for this run/test + the result itself, ordered.
  const timeline = store
    .listAudit()
    .filter((e) => e.runId === run.id || (e.testId === finding.testId && !e.runId))
    .map((e) => ({ at: e.at, event: e.type, detail: sanitize(e.detail, 200) }))
    .sort((a, b) => a.at.localeCompare(b.at));

  const lastHash = store.listAudit()[0]?.hash;

  return {
    findingId: finding.id,
    runId: run.id,
    sessionId: run.agentSessionId,
    traceId: `${run.id}/${finding.testId}`,
    testId: finding.testId,
    severity: finding.severity,
    confidence:
      finding.severity === "critical" || finding.severity === "high" ? "high" : "medium",
    category: finding.category,
    input: sanitize(test.input, 800),
    defense: {
      environment: run.environment,
      description: ENVIRONMENT_INFO[run.environment]?.description ?? run.environment,
    },
    outcome: result
      ? {
          verdict: result.verdict,
          canaryLeaked: result.canaryLeaked,
          privateDataLeaked: result.privateDataLeaked,
          actionExecuted: result.actionExecuted,
          blocked: result.blocked,
        }
      : { verdict: "error", canaryLeaked: false, privateDataLeaked: false, actionExecuted: false, blocked: false },
    toolAttempts: result?.evidence
      .filter((e) => e.kind === "action_check")
      .map((e) => e.content) ?? [],
    policyDecisions: result?.decisions.map((d) => ({
      ruleId: d.ruleId,
      outcome: d.outcome,
      reason: sanitize(d.reason, 200),
    })) ?? [],
    timeline,
    rootCause: rc.rootCause,
    impact: sanitize(finding.description, 600),
    remediation: {
      control: rc.control,
      suggestedChange: rc.change,
      regressionTest: rc.test,
      verifySteps: [
        "Replay the same test ID on the defended environment.",
        "Confirm verdict 'pass' and the expected firewall/policy decision ruleId.",
        "Confirm no finding is regenerated for the replayed run.",
      ],
      source: "deterministic",
    },
    evidence: finding.evidence,
    reproduction: finding.reproductionSteps,
    replayEligible: true,
    verificationStatus: finding.status,
    integrity: {
      note: "Audit events form a SHA-256 hash chain — tampering is detectable; the chain does not by itself prove events true.",
      hashPrefix: lastHash?.slice(0, 12),
    },
  };
}
