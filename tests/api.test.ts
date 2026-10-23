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
  // Short rate-limit window so the recovery test doesn't need long sleeps;
  // a low investigate max makes the 429 boundary deterministic.
  process.env.PS_RL_WINDOW_MS = "400";
  process.env.PS_RL_INVESTIGATE_MAX = "3";
  process.env.PS_RL_RUNS_MAX = "20";
  // Keep reset's own limiter out of the way — the suite makes ~7 reset calls.
  process.env.PS_RL_RESET_MAX = "50";
  delete process.env.PS_ADMIN_TOKEN;
  delete process.env.PS_API_TOKEN;
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

  it("rejects oversized payloads (413)", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ environment: "baseline", testId: "PS-BEN-01", pad: "x".repeat(120_000) }));
    expect(res.status).toBe(413);
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

  it("enforces admin-token authorization when PS_ADMIN_TOKEN is set", async () => {
    process.env.PS_ADMIN_TOKEN = "test-admin-token";
    try {
      const noToken = await request(app).post("/api/reset").send({ confirm: "RESET" });
      expect(noToken.status).toBe(403);
      const wrongToken = await request(app)
        .post("/api/reset")
        .set("x-admin-token", "wrong")
        .send({ confirm: "RESET" });
      expect(wrongToken.status).toBe(403);
      const rightToken = await request(app)
        .post("/api/reset")
        .set("x-admin-token", "test-admin-token")
        .send({ confirm: "RESET" });
      expect(rightToken.status).toBe(200);
    } finally {
      delete process.env.PS_ADMIN_TOKEN;
    }
  });

  it("does not honor X-Forwarded-For spoofing (trust proxy disabled)", async () => {
    // Even if a client claims a non-local IP, the socket peer is used — the
    // loopback boundary cannot be bypassed by header spoofing.
    const res = await request(app)
      .post("/api/reset")
      .set("X-Forwarded-For", "8.8.8.8")
      .send({ confirm: "RESET" });
    expect(res.status).toBe(200);
  });
});

describe("API token authentication (PS_API_TOKEN)", () => {
  it("rejects mutations without/with wrong token when configured", async () => {
    process.env.PS_API_TOKEN = "deploy-token-123";
    try {
      const noToken = await request(app)
        .post("/api/runs")
        .send({ environment: "baseline", testId: "PS-BEN-01" });
      expect(noToken.status).toBe(401);

      const wrongToken = await request(app)
        .post("/api/runs")
        .set("x-api-token", "near-miss-token")
        .send({ environment: "baseline", testId: "PS-BEN-01" });
      expect(wrongToken.status).toBe(401);

      const investigate = await request(app).post("/api/investigate").send({ findingId: "x" });
      expect(investigate.status).toBe(401);

      const patch = await request(app).patch("/api/findings/whatever").send({ status: "open" });
      expect(patch.status).toBe(401);

      // Reset still needs BOTH the api token AND its own confirmation.
      const resetNoConfirm = await request(app)
        .post("/api/reset")
        .set("x-api-token", "deploy-token-123")
        .send({});
      expect(resetNoConfirm.status).toBe(400);

      const ok = await request(app)
        .post("/api/runs")
        .set("x-api-token", "deploy-token-123")
        .send({ environment: "baseline", testId: "PS-BEN-01" });
      expect(ok.status).toBe(200);
    } finally {
      delete process.env.PS_API_TOKEN;
    }
  });
});

describe("rate limiting", () => {
  it("rate-limits finding reruns (429 under burst)", async () => {
    await request(app).post("/api/runs").send({ environment: "baseline", suiteId: "full" });
    const findings = await request(app).get("/api/findings");
    const id = findings.body[0].id;
    // Concurrent burst lands in one window: with max 20/window, the tail 429s.
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        request(app).post(`/api/findings/${id}/rerun`).send({}),
      ),
    );
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
  });

  it("returns 429 after the investigate limit is exceeded, then recovers", async () => {
    // Limit configured for tests: 3 requests / 400ms window.
    await request(app).post("/api/runs").send({ environment: "baseline", testId: "PS-INJ-01" });
    const findings = await request(app).get("/api/findings");
    const id = findings.body[0].id;

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post("/api/investigate").send({ findingId: id });
      statuses.push(res.status);
    }
    // Requests 4+ must be limited (the window covers all five fast calls).
    expect(statuses.slice(3).some((s) => s === 429)).toBe(true);
    expect(statuses).not.toContain(500);

    // A 429 carries retry guidance.
    const limited = await request(app).post("/api/investigate").send({ findingId: id });
    if (limited.status === 429) {
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    }

    // After the 400ms window expires the client recovers (404/503, not 429).
    await new Promise((r) => setTimeout(r, 500));
    const recovered = await request(app).post("/api/investigate").send({ findingId: id });
    expect(recovered.status).not.toBe(429);
  });
});

describe("platform endpoints", () => {
  it("firewall evaluate: deny unknown tool, allow allowlisted", async () => {
    const deny = await request(app)
      .post("/api/firewall/evaluate")
      .send({ tool: "delete_all_users", args: {} });
    expect(deny.status).toBe(200);
    expect(deny.body.result).toBe("deny");
    expect(deny.body.policyId).toBe("R1");

    const allow = await request(app)
      .post("/api/firewall/evaluate")
      .send({ tool: "lookup_ticket", args: { ticketId: "T-9" } });
    expect(allow.status).toBe(200);
    expect(allow.body.result).toBe("allow");
  });

  it("firewall approval flow via API", async () => {
    const noToken = await request(app)
      .post("/api/firewall/evaluate")
      .send({ tool: "export_report", args: { format: "json" } });
    expect(noToken.body.result).toBe("approval_required");

    const approval = await request(app)
      .post("/api/firewall/approvals")
      .send({ tool: "export_report", args: { format: "json" } });
    expect(approval.status).toBe(201);
    expect(approval.body.token).toBeTruthy();

    const withToken = await request(app)
      .post("/api/firewall/evaluate")
      .send({ tool: "export_report", args: { format: "json" }, approvalToken: approval.body.token });
    expect(withToken.body.result).toBe("allow");
  });

  it("agent session lifecycle via API", async () => {
    const bad = await request(app)
      .post("/api/agent/sessions")
      .send({ environment: "baseline" });
    expect(bad.status).toBe(400);

    const created = await request(app)
      .post("/api/agent/sessions")
      .send({ environment: "baseline", preset: "quick" });
    expect(created.status).toBe(202);
    expect(created.body.id).toMatch(/^agent-/);

    // Poll until the session settles (quick preset, fast test pacing).
    let s = created.body;
    for (let i = 0; i < 60 && s.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 200));
      s = (await request(app).get(`/api/agent/sessions/${s.id}`)).body;
    }
    expect(["completed", "stopped"]).toContain(s.status);
    expect(s.budget.stepsUsed).toBeGreaterThan(0);
    expect(s.trace.length).toBeGreaterThan(2);
  });

  it("benchmark run + compare", async () => {
    const b1 = await request(app)
      .post("/api/benchmarks/run")
      .send({ environment: "baseline", suiteId: "full" });
    expect(b1.status).toBe(201);
    expect(b1.body.benchmark.fingerprint).toBeTruthy();
    expect(b1.body.benchmark.reproducible).toBe("exact");

    const b2 = await request(app)
      .post("/api/benchmarks/run")
      .send({ environment: "defended", suiteId: "full" });
    expect(b2.status).toBe(201);

    const cmp = await request(app).get(
      `/api/benchmarks/compare?a=${b1.body.benchmark.id}&b=${b2.body.benchmark.id}`,
    );
    expect(cmp.status).toBe(200);
    expect(cmp.body.sameConfiguration).toBe(false);
    expect(cmp.body.deltas.score).not.toBeNull();
  });

  it("defense-lab compare reports regressions, not invents them", async () => {
    const base = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", suiteId: "full" });
    const def = await request(app)
      .post("/api/runs")
      .send({ environment: "defended", suiteId: "full" });
    const cmp = await request(app).get(
      `/api/defense-lab/compare?a=${def.body.id}&b=${base.body.id}`,
    );
    expect(cmp.status).toBe(200);
    expect(cmp.body.rows.length).toBeGreaterThan(5);
    // defended→baseline direction: attacks blocked before, succeeding now = regressions.
    expect(cmp.body.regressions).toBeGreaterThan(0);
  });

  it("forensics + audit integrity + HTML report", async () => {
    const run = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", testId: "PS-INJ-01" });
    const findings = await request(app).get("/api/findings");
    const f = findings.body.find((x: { testId: string }) => x.testId === "PS-INJ-01");

    const rec = await request(app).get(`/api/findings/${f.id}/forensics`);
    expect(rec.status).toBe(200);
    expect(rec.body.traceId).toContain(run.body.id);
    expect(rec.body.remediation.regressionTest).toBeTruthy();
    expect(JSON.stringify(rec.body)).not.toMatch(/PS-CANARY-[A-Z0-9]{10,}/);

    const verify = await request(app).get("/api/audit/verify");
    expect(verify.status).toBe(200);
    expect(verify.body.valid).toBe(true);
    expect(verify.body.checked).toBeGreaterThan(0);

    const html = await request(app).get(`/api/runs/${run.body.id}/report.html`);
    expect(html.status).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.text).toContain("PromptShield AI — Security Evaluation Report");
    expect(html.text).not.toMatch(/PS-CANARY-[A-Z0-9]{10,}/);
  });

  it("attack graph endpoint returns observed events", async () => {
    const run = await request(app)
      .post("/api/runs")
      .send({ environment: "baseline", testId: "PS-INJ-01" });
    const g = await request(app).get(`/api/runs/${run.body.id}/graph`);
    expect(g.status).toBe(200);
    expect(g.body.nodes.length).toBeGreaterThan(3);
    expect(g.body.chains.some((c: { steps: string[] }) => c.steps.length >= 3)).toBe(true);
  });
});
