/**
 * Gemini integration tests — the @google/genai SDK is fully mocked, so no
 * external API calls occur regardless of local .env configuration.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Finding, RunRecord } from "../shared/types";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

// Short timeout for the hang test; set before the module is imported.
process.env.PS_GEMINI_TIMEOUT_MS = "150";

const run: RunRecord = {
  id: "run-test",
  projectId: "demo-project",
  environment: "baseline",
  suite: "full",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: 1,
  results: [],
  metrics: {} as RunRecord["metrics"],
};

const finding: Finding = {
  id: "find-test",
  testId: "PS-INJ-01",
  runId: "run-test",
  environment: "baseline",
  severity: "critical",
  status: "open",
  title: "Prompt injection disclosed protected context",
  category: "prompt_injection",
  description: "the synthetic canary was disclosed",
  reproductionSteps: ["step"],
  evidence: [
    { kind: "canary_check", label: "Canary disclosure check", content: "FAIL — canary disclosed" },
  ],
  remediation: "Separate trusted instructions from user input.",
  createdAt: new Date().toISOString(),
};

let investigate: typeof import("../server/gemini").investigate;
let GeminiUnavailable: typeof import("../server/gemini").GeminiUnavailable;

beforeAll(async () => {
  const mod = await import("../server/gemini");
  investigate = mod.investigate;
  GeminiUnavailable = mod.GeminiUnavailable;
});

beforeEach(() => {
  generateContent.mockReset();
});

describe("investigate", () => {
  it("rejects with GeminiUnavailable when no key is configured", async () => {
    process.env.GEMINI_API_KEY = "";
    await expect(investigate(run, finding)).rejects.toBeInstanceOf(GeminiUnavailable);
  });

  it("returns a sanitized AI summary on success", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    generateContent.mockResolvedValue({ text: "The canary was disclosed because the pipeline concatenated instructions." });
    const out = await investigate(run, finding);
    expect(out.isAiGenerated).toBe(true);
    expect(out.explanation).toContain("canary");
    expect(out.model).toBeTruthy();
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it("passes an AbortSignal to the SDK (real request cancellation)", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    generateContent.mockResolvedValue({ text: "ok" });
    await investigate(run, finding);
    const cfg = generateContent.mock.calls[0][0].config;
    expect(cfg.abortSignal).toBeInstanceOf(AbortSignal);
    expect(cfg.abortSignal.aborted).toBe(false);
  });

  it("times out a hanging request via the abort signal", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    generateContent.mockImplementation(
      ({ config }: { config: { abortSignal: AbortSignal } }) =>
        new Promise((_, reject) =>
          config.abortSignal.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          ),
        ),
    );
    const start = Date.now();
    await expect(investigate(run, finding)).rejects.toThrow();
    // Must reject promptly (~150ms timeout), not after the real 12s default.
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("propagates provider errors safely", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    generateContent.mockRejectedValue(new Error("quota exceeded"));
    await expect(investigate(run, finding)).rejects.toThrow("quota exceeded");
  });

  it("rejects empty model output", async () => {
    process.env.GEMINI_API_KEY = "test-key-not-real";
    generateContent.mockResolvedValue({ text: "" });
    await expect(investigate(run, finding)).rejects.toThrow("empty");
  });
});
