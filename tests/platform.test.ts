/**
 * Platform feature tests — firewall, agent, graph, forensics, benchmark.
 * Isolated temp storage; no external calls.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.PROMPTSHIELD_DB_PATH = path.join(
  mkdtempSync(path.join(tmpdir(), "promptshield-platform-")),
  "test.json",
);
process.env.PS_AGENT_STEP_DELAY_MS = "10";
process.env.GEMINI_API_KEY = "";

let policy: typeof import("../server/firewall/policy");
let agent: typeof import("../server/agent/session");
let graph: typeof import("../server/graph");
let forensics: typeof import("../server/forensics");
let bench: typeof import("../server/benchmark");
let fixtures: typeof import("../server/engine/fixtures");
let harness: typeof import("../server/engine/harness");
let constants: typeof import("../server/engine/constants");

beforeAll(async () => {
  policy = await import("../server/firewall/policy");
  agent = await import("../server/agent/session");
  graph = await import("../server/graph");
  forensics = await import("../server/forensics");
  bench = await import("../server/benchmark");
  fixtures = await import("../server/engine/fixtures");
  harness = await import("../server/engine/harness");
  constants = await import("../server/engine/constants");
});

const req = (tool: string, args: Record<string, unknown> = {}, extra = {}) => ({
  tool,
  args,
  correlationId: "t-1",
  ...extra,
});

describe("firewall policy engine", () => {
  it("allows an allowlisted tool with valid args", () => {
    const d = policy.evaluate(req("lookup_ticket", { ticketId: "T-123" }));
    expect(d.result).toBe("allow");
  });
  it("denies allowlisted tool with invalid args (R2)", () => {
    const d = policy.evaluate(req("lookup_ticket", { ticketId: "***" }));
    expect(d.result).toBe("deny");
    expect(d.policyId).toBe("R2");
  });
  it("denies unknown tools by default (R1)", () => {
    const d = policy.evaluate(req("delete_all_users"));
    expect(d.result).toBe("deny");
    expect(d.policyId).toBe("R1");
  });
  it("denies args embedding protected markers (R3)", () => {
    const d = policy.evaluate(req("create_ticket", { summary: constants.CANARY_VALUE }));
    expect(d.result).toBe("deny");
    expect(d.policyId).toBe("R3");
  });
  it("approval flow: required → allow once → replay denied; wrong-args denied", () => {
    const args = { format: "json" };
    expect(policy.evaluate(req("export_report", args)).result).toBe("approval_required");
    const { token } = policy.issueApproval("export_report", args);
    expect(policy.evaluate(req("export_report", args, { approvalToken: token })).result).toBe("allow");
    // Replay with the same token denied (single-use).
    expect(policy.evaluate(req("export_report", args, { approvalToken: token })).result).toBe("approval_required");
    // Token bound to args — different args can't reuse a fresh token either.
    const { token: t2 } = policy.issueApproval("export_report", args);
    expect(
      policy.evaluate(req("export_report", { format: "html" }, { approvalToken: t2 })).result,
    ).toBe("approval_required");
  });
  it("denies execution on cancelled/expired sessions (R5)", () => {
    policy.registerSession("sess-1");
    expect(policy.evaluate(req("lookup_ticket", { ticketId: "T-1" }, { sessionId: "sess-1" })).result).toBe("allow");
    policy.closeSession("sess-1");
    expect(policy.evaluate(req("lookup_ticket", { ticketId: "T-1" }, { sessionId: "sess-1" })).result).toBe("deny");
  });
});

describe("red-team agent", () => {
  it("runs the lifecycle and respects step budget", async () => {
    const { session, results } = await agent.runAgent({
      sessionId: "agent-test-1",
      environment: "baseline",
      preset: "quick", // 4 steps max
      owner: "test",
    });
    expect(["completed", "stopped"]).toContain(session.status);
    expect(session.budget.stepsUsed).toBeLessThanOrEqual(4);
    expect(session.budget.stepsUsed).toBeGreaterThan(0);
    expect(results.length).toBe(session.budget.stepsUsed);
    // Trace covers plan → steps → done.
    expect(session.trace[0].phase).toBe("plan");
    expect(session.trace[session.trace.length - 1].phase).toBe("done");
  });

  it("adapts: a verified baseline success escalates the chain", async () => {
    const { session } = await agent.runAgent({
      sessionId: "agent-test-2",
      environment: "baseline",
      preset: "standard",
      owner: "test",
    });
    // PS-INJ-01 fails on baseline → next strategy should escalate to
    // canary_extraction or unauthorized_action per CHAIN map.
    const injStep = session.trace.find((t) => t.testId === "PS-INJ-01" && t.outcome === "success");
    if (injStep) {
      const nextSelect = session.trace.find((t) => t.step === injStep.step + 1 && t.phase === "select")
        ?? session.trace.filter((t) => t.phase === "select").slice(1)[0];
      expect(["canary_extraction", "unauthorized_action"]).toContain(nextSelect?.strategyId);
    }
    expect(session.successfulTestIds.length).toBeGreaterThan(0);
  });

  it("cancellation stops the session between steps", async () => {
    const promise = agent.runAgent({
      sessionId: "agent-test-3",
      environment: "defended",
      preset: "deep",
      owner: "test",
      onStep: (s) => {
        if (s.budget.stepsUsed === 1) agent.cancelSession(s.id);
      },
    });
    const { session } = await promise;
    expect(session.status).toBe("stopped");
    expect(session.stopReason).toBe("cancelled");
    expect(session.budget.stepsUsed).toBeLessThan(12);
  });

  it("defended run blocks attacks and can stop early", async () => {
    const { session } = await agent.runAgent({
      sessionId: "agent-test-4",
      environment: "defended",
      preset: "standard",
      owner: "test",
    });
    expect(session.successfulTestIds.filter((t) => t.startsWith("PS-INJ"))).toHaveLength(0);
  });
});

describe("attack graph", () => {
  it("builds observed nodes/edges and verified chains from a real run", async () => {
    const test = fixtures.getTestCase("PS-INJ-01")!;
    const test2 = fixtures.getTestCase("PS-ACT-01")!;
    const run = {
      id: "run-g1",
      results: [
        harness.executeTest(test, "baseline"),
        harness.executeTest(test2, "baseline"),
      ],
    };
    const testMap = new Map(fixtures.TEST_CASES.map((t) => [t.id, t]));
    const findings = [
      { id: "f1", testId: "PS-INJ-01", runId: "run-g1", severity: "critical" },
    ] as never[];
    const g = graph.buildAttackGraph(run as never, testMap, findings);
    expect(g.nodes.length).toBeGreaterThan(4);
    // Canary-exposure chain detected for INJ-01 (observed, not invented).
    const chain = g.chains.find((c) => c.id === "chain-PS-INJ-01");
    expect(chain).toBeTruthy();
    expect(chain!.label).toMatch(/exposure/i);
    // Unauthorized action chain for ACT-01.
    expect(g.chains.some((c) => c.id === "chain-PS-ACT-01" && /action/i.test(c.label))).toBe(true);
    // Every chain step references a real node id.
    for (const c of g.chains) {
      for (const sid of c.steps) expect(g.nodes.some((n) => n.id === sid)).toBe(true);
    }
  });
});

describe("forensics", () => {
  it("builds a structured, sanitized forensic record", () => {
    const test = fixtures.getTestCase("PS-INJ-01")!;
    const run = {
      id: "run-f1",
      environment: "baseline" as const,
      suite: "full",
      results: [harness.executeTest(test, "baseline")],
    };
    const finding = {
      id: "find-f1",
      testId: "PS-INJ-01",
      runId: "run-f1",
      environment: "baseline" as const,
      severity: "critical" as const,
      status: "open" as const,
      title: "t",
      category: "prompt_injection" as const,
      description: "d",
      reproductionSteps: ["s"],
      evidence: [],
      remediation: "r",
      createdAt: new Date().toISOString(),
    };
    const rec = forensics.buildForensicRecord(finding as never, run as never, test);
    expect(rec.traceId).toContain("run-f1");
    expect(rec.replayEligible).toBe(true);
    expect(rec.remediation.regressionTest).toBeTruthy();
    expect(JSON.stringify(rec)).not.toContain(constants.CANARY_VALUE);
    expect(rec.integrity.note).toMatch(/hash chain/i);
  });
});

describe("benchmark", () => {
  it("fingerprint is deterministic for the same config", () => {
    const fp1 = bench.benchmarkFingerprint({ suiteId: "full", testIds: ["PS-BEN-01", "PS-INJ-01"], environment: "baseline" });
    const fp2 = bench.benchmarkFingerprint({ suiteId: "full", testIds: ["PS-INJ-01", "PS-BEN-01"], environment: "baseline" });
    expect(fp1).toBe(fp2); // order-insensitive
  });
  it("score formula: defended perfect score > baseline", () => {
    const defended = bench.computeBenchmarkScore({
      attackSuccessRate: 0, benignFalseRefusalRate: 0, defenseBlockRate: 1, f1: 1,
    } as never);
    const baseline = bench.computeBenchmarkScore({
      attackSuccessRate: 1, benignFalseRefusalRate: 0.5, defenseBlockRate: 0, f1: 0,
    } as never);
    expect(defended.score).toBe(100);
    // 0.4·(1-1) + 0.15·(1-0.5) + 0.3·0 + 0.15·0 = 0.075 → 7.5
    expect(baseline.score).toBe(7.5);
  });
  it("null denominators are excluded, never fabricated", () => {
    const s = bench.computeBenchmarkScore({
      attackSuccessRate: null, benignFalseRefusalRate: 0.5, defenseBlockRate: null, f1: null,
    } as never);
    // Only BFRR available → score = 100*(1-0.5) = 50.
    expect(s.score).toBe(50);
  });
});
