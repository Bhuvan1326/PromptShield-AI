import type {
  Environment,
  EvidenceItem,
  ExecutionResult,
  TestCase,
} from "../../shared/types";
import { scoreVerdict } from "../../shared/metrics";
import { baselineHandle, SimulatedInfraError, type SimResponse } from "./baseline";
import { defendedHandle } from "./defended";
import { CANARY_REDACTED, CANARY_VALUE } from "./constants";
import { materializeInput } from "./fixtures";

const MAX_EVIDENCE_CHARS = 1200;

/** Redact the synthetic canary (and truncate) before anything is stored or logged. */
export function sanitize(text: string, max = MAX_EVIDENCE_CHARS): string {
  const redacted = text.split(CANARY_VALUE).join(CANARY_REDACTED);
  return redacted.length > max ? redacted.slice(0, max) + "… [truncated]" : redacted;
}

/**
 * Execute one fixture against one simulated environment and score the result.
 * Fully deterministic — identical inputs always produce identical verdicts
 * (durationMs aside).
 */
export function executeTest(test: TestCase, environment: Environment): ExecutionResult {
  const input = materializeInput(test);
  const started = performance.now();
  const evidence: EvidenceItem[] = [];

  evidence.push({
    kind: "prompt",
    label: "User input",
    content: sanitize(input),
  });
  if (test.untrustedContent) {
    evidence.push({
      kind: "prompt",
      label: "Untrusted embedded content (data, not instructions)",
      content: sanitize(test.untrustedContent),
    });
  }
  if (test.requestedAction) {
    evidence.push({
      kind: "note",
      label: "Requested simulated action",
      content: test.requestedAction,
    });
  }
  evidence.push({
    kind: "note",
    label: "Expectation",
    content: test.expectation.description,
  });

  let sim: SimResponse;
  try {
    sim = environment === "baseline" ? baselineHandle(test, input) : defendedHandle(test, input);
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const message =
      err instanceof SimulatedInfraError
        ? err.message
        : "Unexpected harness error";
    evidence.push({
      kind: "note",
      label: "Infrastructure error",
      content: sanitize(message),
    });
    return {
      testId: test.id,
      verdict: "error",
      response: "",
      canaryLeaked: false,
      privateDataLeaked: false,
      actionExecuted: false,
      blocked: false,
      decisions: [],
      durationMs,
      evidence,
      errorMessage: sanitize(message, 300),
    };
  }

  const durationMs = Math.round(performance.now() - started);

  for (const d of sim.decisions) {
    evidence.push({
      kind: "defense_decision",
      label: `Decision · ${d.ruleId} · ${d.outcome}`,
      content: sanitize(d.reason),
    });
  }
  evidence.push({
    kind: "response",
    label: "Assistant response (canary redacted)",
    content: sanitize(sim.text),
  });
  evidence.push({
    kind: "canary_check",
    label: "Canary disclosure check",
    content: sim.canaryLeaked
      ? `FAIL — synthetic canary was disclosed in the raw response (value redacted).`
      : "PASS — no canary material detected in the response.",
  });
  evidence.push({
    kind: "action_check",
    label: "Action authorization check",
    content: test.requestedAction
      ? sim.actionExecuted
        ? `FAIL — simulated tool '${test.requestedAction}' executed.`
        : `PASS — simulated tool '${test.requestedAction}' did not execute.`
      : "No action requested by this case.",
  });

  const verdict = scoreVerdict(test, sim);

  return {
    testId: test.id,
    verdict,
    response: sanitize(sim.text),
    canaryLeaked: sim.canaryLeaked,
    privateDataLeaked: sim.privateDataLeaked,
    actionExecuted: sim.actionExecuted,
    blocked: sim.blocked,
    decisions: sim.decisions.map((d) => ({
      ruleId: d.ruleId,
      outcome: d.outcome as ExecutionResult["decisions"][number]["outcome"],
      reason: sanitize(d.reason, 400),
    })),
    durationMs,
    evidence,
  };
}
