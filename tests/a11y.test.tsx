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
    listRuns: vi.fn(async () => []),
    findings: vi.fn(async () => []),
    audit: vi.fn(async () => []),
  },
}));

import App from "../src/App";

afterEach(cleanup);

async function renderHome() {
  const utils = render(
    <MemoryRouter initialEntries={["/"]}>
      <App />
    </MemoryRouter>,
  );
  // Wait for the lazy Overview chunk and its empty state to resolve.
  await waitFor(() => expect(document.getElementById("main-content")).toBeTruthy());
  return utils;
}

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
