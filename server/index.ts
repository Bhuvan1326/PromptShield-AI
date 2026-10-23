import "dotenv/config";
import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Environment, RunRecord } from "../shared/types";
import { computeMetrics, toScoredResults } from "../shared/metrics";
import { executeTest } from "./engine/harness";
import { ENVIRONMENT_INFO } from "./engine/constants";
import { getTestCase, SUITES, TEST_CASES } from "./engine/fixtures";
import { findingsFromRun } from "./findings";
import { buildReport } from "./report";
import { buildOverview } from "./stats";
import { geminiStatus, GeminiUnavailable, investigate } from "./gemini";
import { id, store } from "./store";

export const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);
app.use(express.json({ limit: "100kb" }));

app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  );
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
    ].join("; "),
  );
  next();
});

function rateLimit(opts: { windowMs: number; max: number; scope: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60_000);
  sweeper.unref();
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${opts.scope}:${req.ip ?? "unknown"}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    res.setHeader("X-RateLimit-Limit", String(opts.max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, opts.max - entry.count)));
    if (entry.count > opts.max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: "Rate limit exceeded. Try again later." });
    }
    next();
  };
}

// Gemini calls cost real quota — strictest limit. Harness runs and the
// destructive reset are limited too, at looser bounds. PS_RL_WINDOW_MS exists
// so tests can use a short window without timing-dependent sleeps.
const rlWindow = (def: number) => Number(process.env.PS_RL_WINDOW_MS) || def;
const investigateLimit = rateLimit({
  windowMs: rlWindow(60_000),
  max: Number(process.env.PS_RL_INVESTIGATE_MAX) || 5,
  scope: "investigate",
});
const runsLimit = rateLimit({
  windowMs: rlWindow(60_000),
  max: Number(process.env.PS_RL_RUNS_MAX) || 30,
  scope: "runs",
});
const resetLimit = rateLimit({
  windowMs: rlWindow(3_600_000),
  max: Number(process.env.PS_RL_RESET_MAX) || 5,
  scope: "reset",
});

const PORT = Number(process.env.PORT) || 8787;
const PROJECT_ID = "demo-project";

const envSchema = z.enum(["baseline", "defended"]);
const runSchema = z
  .object({
    environment: envSchema,
    suiteId: z.string().max(64).optional(),
    testId: z.string().max(64).optional(),
  })
  .refine((v) => Boolean(v.suiteId) !== Boolean(v.testId), {
    message: "Provide exactly one of suiteId or testId.",
  });

function resolveSuiteTests(suiteId: string): string[] | null {
  const suite = SUITES.find((s) => s.id === suiteId);
  return suite ? suite.testIds : null;
}

/** Execute a suite or single test, persist the run + findings + audit events. */
function runHarness(environment: Environment, testIds: string[], suiteLabel: string): RunRecord {
  const startedAt = new Date();
  store.audit({
    type: "run_created",
    environment,
    detail: `Run started on '${environment}' · suite '${suiteLabel}' · ${testIds.length} test(s)`,
  });

  const results = testIds.map((testId) => {
    const test = getTestCase(testId)!;
    const result = executeTest(test, environment);
    store.audit({
      type: "test_executed",
      environment,
      testId,
      detail: `${testId} → ${result.verdict} (${result.durationMs}ms)`,
    });
    return result;
  });

  const finishedAt = new Date();
  const testMap = new Map(TEST_CASES.map((t) => [t.id, t]));
  const scored = toScoredResults(results, testMap);
  const run: RunRecord = {
    id: id("run"),
    projectId: PROJECT_ID,
    environment,
    suite: suiteLabel,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    results,
    metrics: computeMetrics(scored.results, {
      unknownTestIds: scored.unknownTestIds.length,
    }),
  };
  store.addRun(run);

  const findings = findingsFromRun(run, results);
  if (findings.length) store.addFindings(findings);
  for (const f of findings) {
    store.audit({
      type: "finding_created",
      environment,
      runId: run.id,
      testId: f.testId,
      findingId: f.id,
      detail: `${f.severity} finding: ${f.title}`,
    });
  }
  store.audit({
    type: "run_finished",
    environment,
    runId: run.id,
    detail: `Run ${run.id} finished: ${run.metrics.confusion.tp + run.metrics.confusion.tn} pass, ` +
      `${run.metrics.confusion.fp + run.metrics.confusion.fn} fail, ` +
      `${run.metrics.inconclusive} inconclusive, ${run.metrics.errors} error`,
  });
  return run;
}

// --- Routes ----------------------------------------------------------------

app.get("/api/health/status", (_req, res) => {
  const g = geminiStatus();
  res.json({
    gemini: {
      state: g.configured ? "configured" : "missing_key",
      model: g.model,
      message: g.message,
    },
    storage: { state: "ready", kind: store.storageKind },
    engine: { state: "ready", testCases: TEST_CASES.length },
  });
});

app.get("/api/tests", (_req, res) => {
  res.json({
    testCases: TEST_CASES,
    suites: SUITES,
    environments: ENVIRONMENT_INFO,
  });
});

app.post("/api/runs", runsLimit, (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
  }
  const { environment, suiteId, testId } = parsed.data;

  let testIds: string[];
  let suiteLabel: string;
  if (testId) {
    if (!getTestCase(testId)) return res.status(404).json({ error: `Unknown test '${testId}'` });
    testIds = [testId];
    suiteLabel = "single";
  } else {
    const ids = resolveSuiteTests(suiteId!);
    if (!ids) return res.status(404).json({ error: `Unknown suite '${suiteId}'` });
    testIds = ids;
    suiteLabel = suiteId!;
  }

  try {
    res.json(runHarness(environment, testIds, suiteLabel));
  } catch {
    res.status(500).json({ error: "Harness execution failed" });
  }
});

app.get("/api/runs", (_req, res) => {
  res.json(
    store.listRuns().map((r) => ({
      id: r.id,
      environment: r.environment,
      suite: r.suite,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      metrics: r.metrics,
      resultCount: r.results.length,
    })),
  );
});

app.get("/api/runs/:id", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

app.get("/api/runs/:id/report", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  const report = buildReport(run, store.listFindings());
  store.audit({
    type: "report_exported",
    environment: run.environment,
    runId: run.id,
    detail: `JSON report exported for run ${run.id}`,
  });
  res.json(report);
});

app.get("/api/overview", (_req, res) => {
  res.json(buildOverview());
});

app.get("/api/findings", (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  let findings = store.listFindings();
  if (status && ["open", "acknowledged", "resolved"].includes(status)) {
    findings = findings.filter((f) => f.status === status);
  }
  res.json(findings);
});

const findingPatchSchema = z.object({
  status: z.enum(["open", "acknowledged", "resolved"]),
});

app.patch("/api/findings/:id", (req, res) => {
  const parsed = findingPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid status" });
  const f = store.updateFinding(req.params.id, { status: parsed.data.status });
  if (!f) return res.status(404).json({ error: "Finding not found" });
  res.json(f);
});

app.post("/api/findings/:id/rerun", (req, res) => {
  const finding = store.getFinding(req.params.id);
  if (!finding) return res.status(404).json({ error: "Finding not found" });
  const run = runHarness(finding.environment, [finding.testId], "rerun");
  const result = run.results[0];
  if (result.verdict === "pass") {
    store.updateFinding(finding.id, { status: "resolved" });
  }
  res.json({ run, result, finding: store.getFinding(finding.id) });
});

app.post("/api/investigate", investigateLimit, async (req, res) => {
  const schema = z.object({ findingId: z.string().max(128) });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "findingId required" });

  const finding = store.getFinding(parsed.data.findingId);
  if (!finding) return res.status(404).json({ error: "Finding not found" });
  const run = store.getRun(finding.runId);
  if (!run) return res.status(404).json({ error: "Associated run not found" });

  store.audit({
    type: "investigation_requested",
    environment: finding.environment,
    runId: run.id,
    findingId: finding.id,
    detail: `AI investigation requested for finding ${finding.id}`,
  });

  try {
    const out = await investigate(run, finding);
    store.audit({
      type: "investigation_completed",
      environment: finding.environment,
      runId: run.id,
      findingId: finding.id,
      detail: `AI investigation completed for finding ${finding.id} (${out.model})`,
    });
    res.json(out);
  } catch (err) {
    const unavailable = err instanceof GeminiUnavailable;
    store.audit({
      type: "investigation_failed",
      environment: finding.environment,
      runId: run.id,
      findingId: finding.id,
      detail: unavailable ? "Investigation failed: Gemini not configured" : "Investigation failed",
    });
    res.status(unavailable ? 503 : 502).json({
      error: unavailable
        ? err.message
        : "Investigation failed. The deterministic results remain authoritative.",
    });
  }
});

app.get("/api/audit", (_req, res) => {
  res.json(store.listAudit());
});

// Destructive: requires an explicit, validated confirmation body AND an
// authorization check for the actual deployment model:
//   - If PS_ADMIN_TOKEN is set, callers must present it in `x-admin-token`.
//   - Otherwise the endpoint is restricted to loopback clients (the intended
//     local-demo boundary). Non-local callers get 403 regardless of body.
// The confirmation string alone is NOT treated as authentication.
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const resetSchema = z.object({ confirm: z.literal("RESET") });

function requireResetAuthorization(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const adminToken = process.env.PS_ADMIN_TOKEN;
  if (adminToken) {
    if (req.get("x-admin-token") !== adminToken) {
      return res.status(403).json({ error: "Reset requires a valid admin token." });
    }
    return next();
  }
  if (!LOOPBACK.has(req.ip ?? "")) {
    return res.status(403).json({ error: "Reset is restricted to local clients." });
  }
  next();
}

app.post("/api/reset", resetLimit, requireResetAuthorization, (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'Reset requires a confirmation body: {"confirm":"RESET"}' });
  }
  store.reset();
  store.audit({ type: "data_reset", detail: "All runs, findings and audit events cleared" });
  res.json({ ok: true });
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found" }));

// Serve the production build when present (npm run build && npm start).
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

// Tests import `app` and drive it through supertest — only listen when run
// as a server, never inside the test worker.
if (!process.env.VITEST) {
  app.listen(PORT, () => {
    const g = geminiStatus();
    // Never log env values — only configuration state.
    console.log(`PromptShield API listening on http://localhost:${PORT}`);
    console.log(`Gemini: ${g.configured ? `configured (${g.model})` : "not configured (deterministic mode)"}`);
  });
}
