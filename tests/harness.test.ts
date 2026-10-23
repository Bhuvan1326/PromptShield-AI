import { describe, expect, it } from "vitest";
import { executeTest, sanitize } from "../server/engine/harness";
import { getTestCase, TEST_CASES } from "../server/engine/fixtures";
import { CANARY_REDACTED, CANARY_VALUE } from "../server/engine/constants";

const test = (id: string) => {
  const t = getTestCase(id);
  if (!t) throw new Error(`missing fixture ${id}`);
  return t;
};

describe("baseline simulator (intentionally vulnerable)", () => {
  it("leaks the synthetic canary on direct injection → fail", () => {
    const r = executeTest(test("PS-INJ-01"), "baseline");
    expect(r.verdict).toBe("fail");
    expect(r.canaryLeaked).toBe(true);
    // Evidence must be sanitized — raw canary never stored.
    expect(JSON.stringify(r.evidence)).not.toContain(CANARY_VALUE);
    expect(JSON.stringify(r.evidence)).toContain(CANARY_REDACTED);
  });

  it("executes a forbidden simulated tool → fail", () => {
    const r = executeTest(test("PS-ACT-01"), "baseline");
    expect(r.verdict).toBe("fail");
    expect(r.actionExecuted).toBe(true);
  });

  it("ambiguous obfuscated request → inconclusive, not a confirmed leak", () => {
    const r = executeTest(test("PS-INJ-03"), "baseline");
    expect(r.verdict).toBe("inconclusive");
    expect(r.canaryLeaked).toBe(false);
  });

  it("oversized input → error (simulated resource exhaustion)", () => {
    const r = executeTest(test("PS-ROB-02"), "baseline");
    expect(r.verdict).toBe("error");
    expect(r.errorMessage).toBeTruthy();
  });

  it("malformed input processed without validation → fail", () => {
    const r = executeTest(test("PS-ROB-01"), "baseline");
    expect(r.verdict).toBe("fail");
  });

  it("answers benign questions → pass", () => {
    const r = executeTest(test("PS-BEN-01"), "baseline");
    expect(r.verdict).toBe("pass");
  });
});

describe("defended simulator (guardrails)", () => {
  it("blocks direct injection; canary never emitted → pass", () => {
    const r = executeTest(test("PS-INJ-01"), "defended");
    expect(r.verdict).toBe("pass");
    expect(r.blocked).toBe(true);
    expect(r.canaryLeaked).toBe(false);
    expect(r.response).not.toContain(CANARY_VALUE);
  });

  it("neutralizes indirect injection in untrusted quoted text → pass", () => {
    const r = executeTest(test("PS-INJ-02"), "defended");
    expect(r.verdict).toBe("pass");
    expect(r.blocked).toBe(true);
    expect(
      r.decisions.some((d) => d.ruleId === "untrusted.embedded_instruction"),
    ).toBe(true);
  });

  it("blocks canary/private-context extraction → pass", () => {
    const r = executeTest(test("PS-EXT-01"), "defended");
    expect(r.verdict).toBe("pass");
    expect(r.canaryLeaked).toBe(false);
    expect(r.privateDataLeaked).toBe(false);
  });

  it("blocks obfuscated canary request → pass", () => {
    const r = executeTest(test("PS-INJ-03"), "defended");
    expect(r.verdict).toBe("pass");
    expect(r.canaryLeaked).toBe(false);
  });

  it("forbidden action blocking: delete_all_users rejected → pass", () => {
    const r = executeTest(test("PS-ACT-01"), "defended");
    expect(r.verdict).toBe("pass");
    expect(r.actionExecuted).toBe(false);
    expect(r.decisions.some((d) => d.ruleId === "action.allowlist")).toBe(true);
  });

  it("input validation: oversized input rejected → pass", () => {
    const r = executeTest(test("PS-ROB-02"), "defended");
    expect(r.verdict).toBe("pass");
    expect(r.blocked).toBe(true);
    expect(r.decisions.some((d) => d.ruleId === "input.size_limit")).toBe(true);
  });

  it("input validation: control characters rejected → pass", () => {
    const r = executeTest(test("PS-ROB-01"), "defended");
    expect(r.verdict).toBe("pass");
    expect(r.blocked).toBe(true);
    expect(r.decisions.some((d) => d.ruleId === "input.malformed")).toBe(true);
  });

  it("no benign false refusals, including the canary-topic probe → pass", () => {
    for (const id of ["PS-BEN-01", "PS-BEN-02", "PS-BEN-03"]) {
      const r = executeTest(test(id), "defended");
      expect(r.verdict, id).toBe("pass");
      expect(r.blocked, id).toBe(false);
    }
  });
});

describe("sanitize", () => {
  it("redacts canary values and truncates", () => {
    expect(sanitize(`leak: ${CANARY_VALUE}`)).toContain(CANARY_REDACTED);
    expect(sanitize(`leak: ${CANARY_VALUE}`)).not.toContain(CANARY_VALUE);
    expect(sanitize("x".repeat(5000), 100).length).toBeLessThan(120);
  });
});

describe("suite coverage", () => {
  it("includes both positive (attack) and negative (benign) examples", () => {
    const labels = new Set(TEST_CASES.map((t) => t.label));
    expect(labels.has("attack")).toBe(true);
    expect(labels.has("benign")).toBe(true);
    expect(labels.has("invalid")).toBe(true);
    expect(TEST_CASES.length).toBeGreaterThanOrEqual(9);
  });
});
