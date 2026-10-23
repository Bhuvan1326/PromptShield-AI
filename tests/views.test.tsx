import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Shared mock surface — populated defaults; per-test overrides via mockResolvedValueOnce.
vi.mock("../src/lib/api", () => ({
  api: {
    catalog: vi.fn(async () => ({
      testCases: [],
      suites: [{ id: "full", name: "Full suite", description: "d", testIds: [] }],
      environments: {
        baseline: { name: "Baseline", description: "d" },
        defended: { name: "Defended", description: "d" },
      },
    })),
    status: vi.fn(async () => ({
      gemini: { state: "missing_key", model: "gemini-2.0-flash", message: "not configured" },
      storage: { state: "ready", kind: "local-json-file" },
      engine: { state: "ready", testCases: 10 },
      auth: { mode: "local", sessionEnabled: true },
    })),
    overview: vi.fn(async () => ({
      totalRuns: 0, totalTests: 0, confirmedAttackSuccesses: 0,
      attackSuccessRate: null, defenseBlockRate: null, benignFalseRefusalRate: null,
      medianLatencyMs: null, inconclusive: 0, errors: 0, openFindings: 0,
      byEnvironment: { baseline: null, defended: null },
      categoryBreakdown: [], recentRuns: [], topFindings: [],
    })),
    listRuns: vi.fn(async () => []),
    findings: vi.fn(async () => []),
    audit: vi.fn(async () => []),
    agentSessions: vi.fn(async () => []),
    agentSession: vi.fn(async () => null),
    startAgent: vi.fn(),
    cancelAgent: vi.fn(),
    firewallPolicies: vi.fn(async () => ({
      rules: [{ id: "R1", name: "unknown-tool-deny", description: "deny" }],
      toolAllowlist: ["lookup_ticket"], approvalRequired: ["export_report"],
      modes: {}, limitations: "",
    })),
    firewallEvaluate: vi.fn(),
    firewallApprove: vi.fn(),
    benchmarks: vi.fn(async () => ({
      runs: [], suites: [{ id: "full", name: "Full" }],
      scoringFormula: "weighted mean", note: "",
    })),
    runBenchmark: vi.fn(),
    compareBenchmarks: vi.fn(),
    runGraph: vi.fn(async () => ({ nodes: [], edges: [], chains: [] })),
    defenseCompare: vi.fn(async () => ({ a: null, b: null, rows: [], regressions: 0, missingInB: 0, note: "" })),
    forensics: vi.fn(async () => []),
    getRun: vi.fn(),
    auditVerify: vi.fn(async () => ({ valid: true, checked: 3 })),
    session: vi.fn(async () => ({ authenticated: false, role: null, mode: "local" })),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

import App from "../src/App";
import { api } from "../src/lib/api";

afterEach(cleanup);

async function renderRoute(path: string) {
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await waitFor(() => expect(document.getElementById("main-content")).toBeTruthy());
  return utils;
}

const RUN = {
  id: "run-view-1", projectId: "demo", environment: "baseline", suite: "full",
  startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
  durationMs: 10, results: [],
  metrics: { confusion: { tp: 0, fp: 0, tn: 0, fn: 0 } },
};

const SESSION = {
  id: "agent-v1", environment: "baseline", preset: "quick", status: "completed",
  phase: "done", currentStrategy: null, attemptedTestIds: ["PS-INJ-01"],
  successfulTestIds: ["PS-INJ-01"], blockedCount: 0, consecutiveBlocks: 0,
  findings: [], planningSource: "deterministic", stopReason: "budget_steps_exhausted",
  createdAt: new Date().toISOString(), seed: "s",
  budget: { maxSteps: 4, maxMs: 15000, stepsUsed: 4, startedAt: new Date().toISOString() },
  trace: [
    { step: 1, at: new Date().toISOString(), phase: "plan", detail: "plan step" },
    { step: 2, at: new Date().toISOString(), phase: "execute", outcome: "success", detail: "ran PS-INJ-01", strategyId: "direct_injection" },
  ],
};

describe("AgentLab", () => {
  it("lists a completed session in the sessions table", async () => {
    vi.mocked(api.agentSessions).mockResolvedValueOnce([SESSION as never]);
    await renderRoute("/agent");
    await waitFor(() => screen.getByText(/agent-v1/));
    expect(screen.getAllByText("completed").length).toBeGreaterThan(0);
  });

  it("shows the empty state when no sessions exist", async () => {
    vi.mocked(api.agentSessions).mockResolvedValueOnce([]);
    await renderRoute("/agent");
    await waitFor(() => screen.getByText("No agent sessions yet"));
  });

  it("shows an error banner when the sessions API fails", async () => {
    vi.mocked(api.agentSessions).mockRejectedValueOnce(new Error("API down"));
    await renderRoute("/agent");
    await waitFor(() => screen.getByText(/API down/));
  });
});

describe("AttackGraph", () => {
  it("renders populated graph + chain from a selected run", async () => {
    vi.mocked(api.listRuns).mockResolvedValueOnce([
      { id: RUN.id, environment: "baseline", suite: "full", startedAt: RUN.startedAt, resultCount: 10, failed: 4, passed: 6 } as never,
    ]);
    vi.mocked(api.getRun).mockResolvedValueOnce(RUN as never);
    vi.mocked(api.runGraph).mockResolvedValueOnce({
      nodes: [
        { id: "n1", type: "entry", label: "Test PS-INJ-01", testId: "PS-INJ-01" },
        { id: "n2", type: "outcome", label: "verdict: fail", testId: "PS-INJ-01", outcome: "fail" },
      ],
      edges: [{ from: "n1", to: "n2", label: "results in" }],
      chains: [{ id: "c1", label: "Injection exposure", severity: "critical", steps: ["n1", "n2"], summary: "s", evidenceRefs: [] }],
    } as never);
    await renderRoute("/attack-graph");
    await waitFor(() => screen.getByText(/Injection exposure/));
    const chainBtn = screen.getByRole("button", { name: /Injection exposure/ });
    fireEvent.click(chainBtn);
  });

  it("shows the no-runs empty state", async () => {
    vi.mocked(api.listRuns).mockResolvedValueOnce([]);
    await renderRoute("/attack-graph");
    await waitFor(() => screen.getByText("No runs to visualize"));
  });
});

describe("Firewall", () => {
  it("renders policy rules", async () => {
    await renderRoute("/firewall");
    await waitFor(() => screen.getAllByText(/unknown-tool-deny/));
  });
});

describe("DefenseLab", () => {
  it("renders run selectors with accessible names", async () => {
    vi.mocked(api.listRuns).mockResolvedValueOnce([
      { id: "r-base", environment: "baseline", suite: "full", startedAt: RUN.startedAt, resultCount: 10, failed: 4, passed: 6 },
      { id: "r-def", environment: "defended", suite: "full", startedAt: RUN.startedAt, resultCount: 10, failed: 0, passed: 10 },
    ] as never);
    await renderRoute("/defense-lab");
    await waitFor(() => screen.getByRole("combobox", { name: "Reference run" }));
    expect(screen.getByRole("combobox", { name: "Candidate run" })).toBeTruthy();
  });
});

describe("Benchmarks", () => {
  it("renders the empty benchmark state + scoring formula", async () => {
    await renderRoute("/benchmarks");
    await waitFor(() => screen.getByText("No benchmark runs yet"));
    expect(screen.getAllByText(/weighted mean/i).length).toBeGreaterThan(0);
  });
});
