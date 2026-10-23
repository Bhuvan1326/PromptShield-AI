import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import axe from "axe-core";

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
      totalRuns: 0,
      totalTests: 0,
      confirmedAttackSuccesses: 0,
      attackSuccessRate: null,
      defenseBlockRate: null,
      benignFalseRefusalRate: null,
      medianLatencyMs: null,
      inconclusive: 0,
      errors: 0,
      openFindings: 0,
      byEnvironment: { baseline: null, defended: null },
      categoryBreakdown: [],
      recentRuns: [],
      topFindings: [],
    })),
    listRuns: vi.fn(async () => [
      {
        id: "run-a11y-1",
        environment: "baseline",
        suite: "full",
        startedAt: new Date().toISOString(),
        resultCount: 10,
        failed: 4,
        passed: 6,
      },
    ]),
    findings: vi.fn(async () => []),
    audit: vi.fn(async () => []),
    agentSessions: vi.fn(async () => []),
    agentSession: vi.fn(async () => null),
    startAgent: vi.fn(),
    cancelAgent: vi.fn(),
    firewallPolicies: vi.fn(async () => ({
      rules: [
        { id: "R1", name: "unknown-tool-deny", description: "deny unknown tools" },
        { id: "R2", name: "arg-validation", description: "validate args" },
      ],
      toolAllowlist: ["lookup_ticket", "create_ticket"],
      approvalRequired: ["export_report"],
      modes: { test: "t", integration: "i" },
      limitations: "l",
    })),
    firewallEvaluate: vi.fn(),
    firewallApprove: vi.fn(),
    benchmarks: vi.fn(async () => ({
      runs: [],
      suites: [{ id: "full", name: "Full" }],
      scoringFormula: "score = weighted mean",
      note: "n",
    })),
    runBenchmark: vi.fn(),
    compareBenchmarks: vi.fn(),
    runGraph: vi.fn(async () => ({
      nodes: [
        { id: "n1", type: "entry", label: "Test PS-INJ-01", testId: "PS-INJ-01" },
        { id: "n2", type: "untrusted_input", label: "user input", testId: "PS-INJ-01", evidence: ["x"] },
        { id: "n3", type: "technique", label: "prompt injection", testId: "PS-INJ-01" },
        { id: "n4", type: "outcome", label: "verdict: fail", testId: "PS-INJ-01", outcome: "fail" },
      ],
      edges: [
        { from: "n1", to: "n2", label: "presents" },
        { from: "n2", to: "n3", label: "attempts", inferred: true },
        { from: "n3", to: "n4", label: "results in" },
      ],
      chains: [
        {
          id: "chain-PS-INJ-01",
          label: "Injection → exposure",
          severity: "critical",
          steps: ["n2", "n3", "n4"],
          summary: "observed chain",
          evidenceRefs: ["f1"],
        },
      ],
    })),
    defenseCompare: vi.fn(async () => ({
      a: { id: "run-a11y-1", environment: "baseline", suite: "full", metrics: {}, startedAt: new Date().toISOString() },
      b: { id: "run-a11y-1", environment: "defended", suite: "full", metrics: {}, startedAt: new Date().toISOString() },
      rows: [],
      regressions: 0,
      missingInB: 0,
      note: "n",
    })),
    forensics: vi.fn(),
    getRun: vi.fn(async () => ({
      id: "run-a11y-1",
      projectId: "demo",
      environment: "baseline",
      suite: "full",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 10,
      results: [],
      metrics: {},
    })),
    auditVerify: vi.fn(async () => ({ valid: true, checked: 3 })),
    session: vi.fn(async () => ({ authenticated: false, role: null, mode: "local" })),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

import App from "../src/App";

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

const renderHome = () => renderRoute("/");

describe("accessibility — app shell", () => {
  it("provides a skip-to-main-content link targeting a real landmark", async () => {
    const { container } = await renderHome();
    const skip = container.querySelector<HTMLAnchorElement>('a[href="#main-content"]');
    expect(skip).toBeTruthy();
    expect(skip!.textContent).toMatch(/skip to main/i);
    expect(document.getElementById("main-content")).toBeTruthy();
  });

  it("exposes nav and main landmarks", async () => {
    const { container } = await renderHome();
    expect(container.querySelector("nav")).toBeTruthy();
    expect(container.querySelector("main#main-content")).toBeTruthy();
  });

  it("has a level-1 heading on the page", async () => {
    await renderHome();
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { level: 1 }).length).toBeGreaterThanOrEqual(1),
    );
  });

  it("reports no axe violations on the shell (structural rules)", async () => {
    const { container } = await renderHome();
    const results = await axe.run(container, {
      rules: {
        // jsdom cannot evaluate real layout/color — disabled honestly.
        "color-contrast": { enabled: false },
      },
    });
    expect(results.violations).toEqual([]);
  });
});

const AXE_OPTS: axe.RunOptions = { rules: { "color-contrast": { enabled: false } } };

describe("accessibility — platform views", () => {
  for (const [path, name] of [
    ["/agent", "Red Team Agent"],
    ["/firewall", "Runtime Firewall"],
    ["/benchmarks", "Benchmark Arena"],
    ["/attack-graph", "Attack Graph"],
    ["/defense-lab", "Defense Lab"],
  ] as const) {
    it(`${name}: axe-clean and has an h1`, async () => {
      const { container } = await renderRoute(path);
      await waitFor(() => {
        expect(container.querySelector("h1")).toBeTruthy();
      });
      expect(container.querySelector("h1")!.textContent!.length).toBeGreaterThan(2);
      const results = await axe.run(container, AXE_OPTS);
      expect(results.violations).toEqual([]);
    });
  }

  it("Firewall: form controls have accessible names", async () => {
    const { container } = await renderRoute("/firewall");
    await waitFor(() => expect(container.querySelector("#fw-tool")).toBeTruthy());
    for (const sel of ["#fw-tool", "#fw-args", "#fw-token"]) {
      expect(container.querySelector(sel), `${sel} should exist`).toBeTruthy();
      const label = container.querySelector(`label[for="${sel.slice(1)}"]`);
      expect(label, `${sel} should have an associated <label>`).toBeTruthy();
    }
  });

  it("Agent: preset control and start button are keyboard-reachable", async () => {
    const { container } = await renderRoute("/agent");
    await waitFor(() => {
      expect([...container.querySelectorAll("button")].some((b) => /start agent/i.test(b.textContent ?? ""))).toBe(true);
    });
    const startBtn = [...container.querySelectorAll("button")].find((b) => /start agent/i.test(b.textContent ?? ""))!;
    startBtn.focus();
    expect(document.activeElement).toBe(startBtn);
    // All interactive elements are buttons/inputs/selects/links — tabbable.
    for (const el of container.querySelectorAll("[role='button'], button, select, input, a")) {
      const tag = el.tagName.toLowerCase();
      if (tag === "a") continue;
      expect(el.getAttribute("tabindex") !== "-1").toBe(true);
    }
  });

  it("Defense Lab: run selectors have accessible names", async () => {
    const { container } = await renderRoute("/defense-lab");
    await waitFor(() => expect(container.querySelectorAll("select").length).toBeGreaterThanOrEqual(1));
    for (const sel of container.querySelectorAll("select")) {
      const named =
        sel.getAttribute("aria-label") ||
        sel.id ||
        sel.closest("label")?.textContent?.trim();
      expect(named).toBeTruthy();
    }
  });
});
