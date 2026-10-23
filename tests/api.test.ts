/**
 * API integration tests — drive the real Express app via supertest.
 *
 * Isolation guarantees:
 *  - PROMPTSHIELD_DB_PATH points at a fresh temp file per test-file run, so
 *    developer/production data is never loaded or mutated.
 *  - DOTENV_CONFIG_PATH points at a nonexistent file and GEMINI_API_KEY is
 *    cleared, so tests can never call the real Gemini API even if the dev
 *    has a key in .env.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Express } from "express";
import { CANARY_VALUE } from "../server/engine/constants";

let app: Express;

beforeAll(async () => {
  process.env.DOTENV_CONFIG_PATH = "/nonexistent-promptshield-env";
  process.env.GEMINI_API_KEY = "";
  process.env.PROMPTSHIELD_DB_PATH = path.join(
    mkdtempSync(path.join(tmpdir(), "promptshield-test-")),
    "test-data.json",
  );
  const mod = await import("../server/index");
  app = mod.app;
});

describe("health/status", () => {
  it("reports components without disclosing filesystem paths", async () => {
    const res = await request(app).get("/api/health/status");
    expect(res.status).toBe(200);
    expect(res.body.engine.testCases).toBeGreaterThan(0);
    expect(res.body.gemini.state).toBe("missing_key");
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Za-z]:\\|\/home\/|promptshield\.json/);
    expect(res.body.storage).not.toHaveProperty("path");
  });

  it("sets security headers", async () => {
    const res = await request(app).get("/api/health/status");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
  });
});

describe("POST /api/runs", () => {
  it("rejects invalid environment", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ environment: "bogus", suiteId: "full" });
    expect(res.status).toBe(400);
  });

  it("rejects missing suiteId/testId", async () => {
    const res = await request(app).post("/api/runs").send({ environment: "baseline" });
    expect(res.status).toBe(400);
  });

  it("rejects both suiteId and testId together", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", suiteId: "full", testId: "PS-BEN-01" });
    expect(res.status).toBe(400);
  });

  it("404s on unknown testId and suiteId", async () => {
    const r1 = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", testId: "NOPE-99" });
    expect(r1.status).toBe(404);
    const r2 = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", suiteId: "nonexistent" });
    expect(r2.status).toBe(404);
  });

  it("executes and returns a scored run", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", testId: "PS-INJ-01" });
    expect(res.status).toBe(200);
    expect(res.body.results[0].verdict).toBe("fail");
    expect(res.body.results[0].canaryLeaked).toBe(true);
    expect(res.body.metrics.unknownTestIds).toBe(0);
  });
});

describe("canary redaction", () => {
  it("never returns the raw canary value in run or findings payloads", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", suiteId: "full" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(CANARY_VALUE);

    const findings = await request(app).get("/api/findings");
    expect(JSON.stringify(findings.body)).not.toContain(CANARY_VALUE);

    const audit = await request(app).get("/api/audit");
    expect(JSON.stringify(audit.body)).not.toContain(CANARY_VALUE);
  });
});

describe("findings rerun flow", () => {
  it("reruns a finding's test and reports the new verdict", async () => {
    const findings = await request(app).get("/api/findings");
    const finding = findings.body[0];
    expect(finding).toBeTruthy();
    const res = await request(app).post(`/api/findings/${finding.id}/rerun`).send({});
    expect(res.status).toBe(200);
    expect(res.body.result.testId).toBe(finding.testId);
    // Baseline rerun still fails → finding stays open.
    expect(res.body.finding.status).toBe("open");
  });

  it("404s rerunning a nonexistent finding", async () => {
    const res = await request(app).post("/api/findings/find-nope/rerun").send({});
    expect(res.status).toBe(404);
  });
});

describe("report export", () => {
  it("exports a JSON report for an existing run", async () => {
    const runs = await request(app).get("/api/runs");
    const res = await request(app).get(`/api/runs/${runs.body[0].id}/report`);
    expect(res.status).toBe(200);
    expect(res.body.reportVersion).toBe("1.0.0");
    expect(res.body.metrics).toBeTruthy();
    expect(res.body.limitations.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain(CANARY_VALUE);
  });

  it("404s for a missing run", async () => {
    const res = await request(app).get("/api/runs/run-nope/report");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/investigate", () => {
  it("validates the request body", async () => {
    const res = await request(app).post("/api/investigate").send({});
    expect(res.status).toBe(400);
  });

  it("returns a safe fallback when Gemini is not configured", async () => {
    const findings = await request(app).get("/api/findings");
    const res = await request(app)
      .post("/api/investigate")
      .send({ findingId: findings.body[0].id });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/not configured/i);
  });
});

describe("POST /api/reset", () => {
  it("requires explicit confirmation", async () => {
    const noBody = await request(app).post("/api/reset").send({});
    expect(noBody.status).toBe(400);
    const wrong = await request(app).post("/api/reset").send({ confirm: "yes" });
    expect(wrong.status).toBe(400);
  });

  it("resets with the confirmation body", async () => {
    const res = await request(app).post("/api/reset").send({ confirm: "RESET" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const runs = await request(app).get("/api/runs");
    expect(runs.body.length).toBe(0);
  });
});

describe("rate limiting", () => {
  it("returns 429 after the investigate limit is exceeded", async () => {
    // Default investigate limit: 5/min. Seed one finding for valid IDs.
    await request(app).post("/api/runs").send({ environment: "baseline", testId: "PS-INJ-01" });
    const findings = await request(app).get("/api/findings");
    const id = findings.body[0].id;

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await request(app).post("/api/investigate").send({ findingId: id });
      statuses.push(res.status);
    }
    // An earlier test already consumed one request from the same per-IP
    // window, so the 429 boundary may fall inside this loop — assert the
    // limiter engages and rejects the tail rather than asserting an index.
    expect(statuses[statuses.length - 1]).toBe(429);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses).not.toContain(500);
  });
});
