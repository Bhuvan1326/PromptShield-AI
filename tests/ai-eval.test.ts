import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Finding, RunRecord } from "../shared/types";
import { CANARY_VALUE } from "../server/engine/constants";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

let analyzeRunWithGemini: typeof import("../server/ai-eval").analyzeRunWithGemini;
let planTestsWithGemini: typeof import("../server/ai-eval").planTestsWithGemini;
let GeminiUnavailable: typeof import("../server/gemini").GeminiUnavailable;

beforeAll(async () => {
  const mod = await import("../server/ai-eval");
  analyzeRunWithGemini = mod.analyzeRunWithGemini;
  planTestsWithGemini = mod.planTestsWithGemini;
  const g = await import("../server/gemini");
  GeminiUnavailable = g.GeminiUnavailable;
});

beforeEach(() => {
  generateContent.mockReset();
  process.env.GEMINI_API_KEY = "test-key-not-real";
});

const run = {
  id: "run-1",
  projectId: "demo",
  environment: "baseline",
  suite: "full",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 5,
  results: [
    {
      testId: "PS-INJ-01",
      verdict: "fail",
      response: "leaked",
      canaryLeaked: true,
      privateDataLeaked: false,
      actionExecuted: false,
      blocked: false,
      decisions: [],
      durationMs: 5,
      evidence: [],
    },
  ],
  metrics: { total: 1, confusion: { tp: 0, fp: 0, tn: 0, fn: 1 } },
} as unknown as RunRecord;

const findings: Finding[] = [
  {
    id: "find-1",
    testId: "PS-INJ-01",
    runId: "run-1",
    environment: "baseline",
    severity: "critical",
    status: "open",
    title: "Canary disclosed",
    category: "prompt_injection",
    description: "d",
    reproductionSteps: [],
    evidence: [],
    remediation: "r",
    createdAt: new Date().toISOString(),
  },
];

describe("analyzeRunWithGemini", () => {
  it("returns schema-validated advisory analysis", async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        attackIntent: "Extract the planted canary via instruction override.",
        assessment: "agree",
        reasoning: "Response contains the redacted canary marker.",
        evidenceSummary: "1 scored attack, 1 finding.",
        suggestedTests: [{ title: "T", input: "try X", rationale: "r" }],
        mitigations: ["Separate trusted instructions from user text."],
      }),
    });
    const out = await analyzeRunWithGemini(run, findings);
    expect(out.isAiGenerated).toBe(true);
    expect(out.assessment).toBe("agree");
    expect(out.model).toBeTruthy();
    expect(out.methodology).toMatch(/deterministic/i);
  });

  it("rejects malformed JSON from the model", async () => {
    generateContent.mockResolvedValue({ text: "not json {{{" });
    await expect(analyzeRunWithGemini(run, findings)).rejects.toThrow(/JSON/);
  });

  it("rejects JSON failing the schema", async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({ attackIntent: "x", assessment: "maybe" }),
    });
    await expect(analyzeRunWithGemini(run, findings)).rejects.toThrow(/schema/i);
  });

  it("does not echo the raw canary into the prompt", async () => {
    generateContent.mockResolvedValue({ text: "{}" });
    await analyzeRunWithGemini(run, findings).catch(() => {});
    const prompt = String(generateContent.mock.calls[0][0].contents);
    expect(prompt).not.toContain(CANARY_VALUE);
  });

  it("propagates an AbortSignal to the SDK", async () => {
    generateContent.mockResolvedValue({ text: "{}" });
    await analyzeRunWithGemini(run, findings).catch(() => {});
    expect(generateContent.mock.calls[0][0].config.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe("planTestsWithGemini", () => {
  it("allowlists model suggestions to the fixture catalog", async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        rationale: "covers canary + injection surface",
        recommendedTestIds: ["PS-INJ-01", "EVIL-99", "PS-EXT-01"],
        warnings: ["limited coverage"],
      }),
    });
    const out = await planTestsWithGemini("injection coverage");
    expect(out.recommendedTestIds).toEqual(["PS-INJ-01", "PS-EXT-01"]);
    expect(out.ignoredTestIds).toEqual(["EVIL-99"]);
  });

  it("dedupes repeated suggestions", async () => {
    generateContent.mockResolvedValue({
      text: JSON.stringify({
        rationale: "r",
        recommendedTestIds: ["PS-BEN-01", "PS-BEN-01", "PS-BEN-02"],
        warnings: [],
      }),
    });
    const out = await planTestsWithGemini("benign coverage");
    expect(out.recommendedTestIds).toEqual(["PS-BEN-01", "PS-BEN-02"]);
  });

  it("fails cleanly without a configured key", async () => {
    process.env.GEMINI_API_KEY = "";
    await expect(planTestsWithGemini("x")).rejects.toBeInstanceOf(GeminiUnavailable);
  });
});
