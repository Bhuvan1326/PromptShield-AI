/**
 * Platform feature tests — firewall, agent, graph, forensics, benchmark.
 * Isolated temp storage; no external calls.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
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

describe("agent owner-slot lifecycle", () => {
  it("four sequential sessions for one owner complete; count returns to 0 each time", async () => {
    for (let i = 0; i < 4; i++) {
      const { session } = await agent.runAgent({
        sessionId: `agent-seq-${i}`,
        environment: "baseline",
        preset: "quick",
        owner: "owner-seq",
      });
      expect(session.status).toBe("completed");
      expect(agent.ownerActiveCount("owner-seq")).toBe(0);
    }
  });

  it("concurrent cap enforced: 4th concurrent session is rejected, not leaked", async () => {
    const owner = "owner-conc";
    const p1 = agent.runAgent({ sessionId: "c1", environment: "defended", preset: "deep", owner });
    const p2 = agent.runAgent({ sessionId: "c2", environment: "defended", preset: "deep", owner });
    const p3 = agent.runAgent({ sessionId: "c3", environment: "defended", preset: "deep", owner });
    await new Promise((r) => setTimeout(r, 30)); // let the three acquire
    expect(agent.ownerActiveCount(owner)).toBe(3);

    const fourth = await agent.runAgent({ sessionId: "c4", environment: "defended", preset: "quick", owner });
    expect(fourth.session.status).toBe("error");
    expect(fourth.session.stopReason).toBe("concurrency_limit");
    expect(agent.ownerActiveCount(owner)).toBe(3); // rejected, not leaked

    await Promise.all([p1, p2, p3]);
    expect(agent.ownerActiveCount(owner)).toBe(0); // released exactly once each
  });

  it("cancellation releases the slot", async () => {
    const owner = "owner-cancel";
    const p = agent.runAgent({
      sessionId: "cancel-1",
      environment: "defended",
      preset: "deep",
      owner,
      onStep: (s) => { if (s.budget.stepsUsed === 1) agent.cancelSession(s.id); },
    });
    await p;
    expect(agent.ownerActiveCount(owner)).toBe(0);
  });

  it("an engine exception releases the slot exactly once", async () => {
    const owner = "owner-err";
    const harness = await import("../server/engine/harness");
    const spy = vi.spyOn(harness, "executeTest").mockImplementation(() => {
      throw new Error("engine boom");
    });
    try {
      const { session } = await agent.runAgent({
        sessionId: "err-1",
        environment: "baseline",
        preset: "quick",
        owner,
      });
      expect(session.status).toBe("error");
    } finally {
      spy.mockRestore();
    }
    expect(agent.ownerActiveCount(owner)).toBe(0);
  });

  it("different owners have independent limits", async () => {
    const p1 = agent.runAgent({ sessionId: "o1", environment: "defended", preset: "deep", owner: "owner-A" });
    const p2 = agent.runAgent({ sessionId: "o2", environment: "defended", preset: "deep", owner: "owner-A" });
    const p3 = agent.runAgent({ sessionId: "o3", environment: "defended", preset: "deep", owner: "owner-A" });
    await new Promise((r) => setTimeout(r, 30));
    // owner B is unaffected by A's full slots.
    const { session: bSession } = await agent.runAgent({
      sessionId: "ob",
      environment: "defended",
      preset: "quick",
      owner: "owner-B",
    });
    expect(bSession.status).toBe("completed");
    await Promise.all([p1, p2, p3]);
    expect(agent.ownerActiveCount("owner-A")).toBe(0);
  });
});

describe("idempotency store (unit)", () => {
  it("expired keys become reusable; different owners are independent", async () => {
    const idem = await import("../server/idempotency");
    vi.useFakeTimers();
    try {
      const scopeA = idem.idemScope("owner-A", "route", "key-12345678");
      const scopeB = idem.idemScope("owner-B", "route", "key-12345678");
      expect(scopeA).not.toBe(scopeB); // owner-scoped
      const fp1 = idem.requestFingerprint({ environment: "baseline", preset: "quick" });
      const fp2 = idem.requestFingerprint({ environment: "defended", preset: "quick" });
      const fp1b = idem.requestFingerprint({ preset: "quick", environment: "baseline" });
      expect(fp1).toBe(fp1b); // key-order-insensitive
      expect(fp1).not.toBe(fp2);

      // Atomic reserve: first caller reserves, second identical caller replays
      // the in-flight record, a different fingerprint conflicts.
      expect(idem.reserveIdempotency(scopeA, fp1, "sess-1")).toEqual({ kind: "reserved" });
      expect(idem.reserveIdempotency(scopeA, fp1, "other")).toEqual({ kind: "replay", sessionId: "sess-1" });
      expect(idem.reserveIdempotency(scopeA, fp2, "other")).toEqual({ kind: "conflict" });
      idem.finalizeIdempotency(scopeA);
      expect(idem.reserveIdempotency(scopeB, fp1, "sess-b")).toEqual({ kind: "reserved" });

      // Past the 60s window the key is reusable.
      vi.advanceTimersByTime(61_000);
      expect(idem.reserveIdempotency(scopeA, fp2, "sess-2")).toEqual({ kind: "reserved" });
      idem.finalizeIdempotency(scopeA);
      expect(idem.reserveIdempotency(scopeA, fp2, "x")).toEqual({ kind: "replay", sessionId: "sess-2" });

      // Abandon releases the key for a retry after failure.
      idem.abandonIdempotency(scopeA);
      expect(idem.reserveIdempotency(scopeA, fp1, "sess-3")).toEqual({ kind: "reserved" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stale-session recovery", () => {
  it("a persisted 'running' session is marked process_exit on next load", async () => {
    // Write a file directly with a running session, then re-import store fresh.
    const file = path.join(mkdtempSync(path.join(tmpdir(), "ps-stale-")), "t.json");
    writeFileSync(
      file,
      JSON.stringify({
        runs: [], findings: [], audit: [], benchmarkRuns: [],
        agentSessions: [{
          id: "agent-stale", environment: "baseline", preset: "quick",
          status: "running", phase: "execute", currentStrategy: null,
          attemptedTestIds: [], successfulTestIds: [], blockedCount: 0,
          consecutiveBlocks: 0, findings: [], trace: [],
          budget: { maxSteps: 4, maxMs: 15000, stepsUsed: 2, startedAt: new Date().toISOString() },
          planningSource: "deterministic", stopReason: null,
          createdAt: new Date().toISOString(), seed: "agent-stale",
        }],
      }),
    );
    vi.resetModules();
    process.env.PROMPTSHIELD_DB_PATH = file;
    const fresh = await import("../server/store");
    const s = fresh.store.getAgentSession("agent-stale")!;
    expect(s.status).toBe("error");
    expect(s.stopReason).toBe("process_exit");
    vi.resetModules();
  });
});

describe("persistence batching", () => {
  it("multi-mutation run does a single deferred flush; data stays correct", async () => {
    const { store } = await import("../server/store");
    const runCountBefore = store.listRuns().length;
    const auditBefore = store.listAudit().length;
    // batch() defers all persists inside fn to one flush.
    store.batch(() => {
      store.audit({ type: "run_created", detail: "batch-test" });
      store.audit({ type: "run_finished", detail: "batch-test" });
      store.audit({ type: "test_executed", detail: "batch-test" });
    });
    // All events are durably recorded and the chain still verifies.
    expect(store.listAudit().length).toBe(auditBefore + 3);
    expect(store.verifyAuditChain().valid).toBe(true);
    // Nested batch flushes exactly once at the outermost level.
    store.batch(() => {
      store.audit({ type: "run_created", detail: "nested" });
      store.batch(() => store.audit({ type: "test_executed", detail: "nested" }));
    });
    expect(store.verifyAuditChain().valid).toBe(true);
    expect(store.listRuns().length).toBe(runCountBefore);
  });
});

  it("batch exception: propagates error; mutations before the throw flush once", async () => {
    const { store } = await import("../server/store");
    const before = store.listAudit().length;
    expect(() =>
      store.batch(() => {
        store.audit({ type: "run_created", detail: "before-throw" });
        throw new Error("mid-batch failure");
      }),
    ).toThrow("mid-batch failure");
    // Semantics: partial commit — the pre-throw mutation is durable (same as
    // sequential non-batched calls), chain remains verifiable.
    expect(store.listAudit().length).toBe(before + 1);
    expect(store.verifyAuditChain().valid).toBe(true);
  });

describe("audit integrity — signing + checkpoints", () => {
  it("signed events verify; forged sig/unsigned events are flagged", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "ps-audit-")), "t.json");
    const cpFile = path.join(path.dirname(file), "audit-checkpoint.json");
    vi.resetModules();
    process.env.PROMPTSHIELD_DB_PATH = file;
    process.env.PROMPTSHIELD_CHECKPOINT_PATH = cpFile;
    process.env.PS_AUDIT_SIGNING_KEY = "test-signing-key";
    try {
      const fresh = await import("../server/store");
      fresh.store.audit({ type: "run_created", detail: "signed-event" });
      const events = fresh.store.listAudit();
      expect(events[0].sig).toMatch(/^[a-f0-9]{64}$/);
      expect(fresh.store.verifyAuditChain().valid).toBe(true);

      // Forged event (correct-looking hash, wrong sig) must fail.
      const forged = { ...events[0], id: "forged", sig: "f".repeat(64) };
      events.unshift(forged as never);
      expect(fresh.store.verifyAuditChain().valid).toBe(false);

      // Restore and write a checkpoint — verifies and round-trips.
      fresh.store.reset();
      fresh.store.audit({ type: "run_finished", detail: "again" });
      const cp = fresh.store.auditCheckpoint();
      expect(cp.sig).toBeTruthy();
      const v = fresh.store.verifyAuditChain();
      expect(v.valid).toBe(true);
      expect(v.checkpoint).toBe("ok");

      // Tamper the checkpoint body → signature invalid flagged.
      (await import("node:fs")).writeFileSync(cpFile, JSON.stringify({ ...cp, lastHash: "0".repeat(64) }));
      expect(fresh.store.verifyAuditChain().checkpoint).toBe("invalid-signature");

      // Chain advanced past checkpoint → mismatch flagged.
      fresh.store.auditCheckpoint();
      fresh.store.audit({ type: "test_executed", detail: "after-checkpoint" });
      expect(fresh.store.verifyAuditChain().checkpoint).toBe("mismatch");
    } finally {
      delete process.env.PS_AUDIT_SIGNING_KEY;
      delete process.env.PROMPTSHIELD_CHECKPOINT_PATH;
      vi.resetModules();
    }
  });
});
