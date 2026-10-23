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
import { requireApiToken, safeTokenEqual } from "./auth";
import { memoryCoordinator, redisCoordinator, type Coordinator } from "./coordination";
import {
  canAccess,
  clearSessionCookie,
  createSession,
  destroySession,
  ownerOf,
  readSessionId,
  sessionCookie,
  sessionRole,
} from "./session";
import { analyzeRunWithGemini, planTestsWithGemini } from "./ai-eval";
import {
  cancelSession,
  ownerActiveCount,
  runAgent,
  MAX_CONCURRENT_PER_OWNER,
  PRESETS,
} from "./agent/session";
import {
  IDEM_KEY_RE,
  idemScope,
  requestFingerprint,
} from "./idempotency";
import { buildAttackGraph } from "./graph";
import { buildForensicRecord } from "./forensics";
import { toBenchmarkRun } from "./benchmark";
import {
  evaluate as firewallEvaluate,
  issueApproval,
  POLICY_RULES,
  TOOL_ALLOWLIST,
  APPROVAL_REQUIRED,
} from "./firewall/policy";
import type { BenchmarkWeights } from "../shared/types";
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


// Shared coordinator assigned at startup before listen(); rateLimit resolves
// it lazily per request (assigned once — ref avoids a reassigned `let`).
const coordinatorRef: { current: Coordinator | null } = { current: null };

function rateLimit(opts: { windowMs: number; max: number; scope: string }) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, 60_000);
  sweeper.unref();
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = `${opts.scope}:${req.ip ?? "unknown"}`;
    if (coordinatorRef.current?.kind === "redis") {
      try {
        const ok = await coordinatorRef.current.rateLimit(opts.scope, key, opts.windowMs, opts.max);
        res.setHeader("X-RateLimit-Limit", String(opts.max));
        if (!ok) {
          res.setHeader("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
          return res.status(429).json({ error: "Rate limit exceeded. Try again later." });
        }
        return next();
      } catch {
        return res.status(503).json({ error: "Rate limiting unavailable." });
      }
    }
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
// Dedicated scope for agent-session creation — independent from `runs` so
// benchmark/firewall traffic can't starve (or be starved by) agent sessions.
const agentLimit = rateLimit({
  windowMs: rlWindow(60_000),
  max: Number(process.env.PS_RL_AGENT_MAX) || 10,
  scope: "agent",
});
const authLimit = rateLimit({
  windowMs: rlWindow(60_000),
  max: Number(process.env.PS_RL_AUTH_MAX) || 10,
  scope: "auth",
});

// Coordination backend for owner-slots + idempotency. PS_COORDINATION=redis
// + PS_REDIS_URL selects the shared atomic store (multi-instance); anything
// else uses the tested process-local memory impl. A requested-but-unreachable
// Redis fails closed at startup rather than silently degrading.
async function createCoordinator(): Promise<Coordinator> {
  if (process.env.PS_COORDINATION === "redis") {
    const url = process.env.PS_REDIS_URL;
    if (!url) throw new Error("PS_COORDINATION=redis requires PS_REDIS_URL");
    const { Redis } = await import("ioredis");
    const client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
    await client.connect();
    console.log("[PromptShield] coordination backend: redis");
    return redisCoordinator(client);
  }
  return memoryCoordinator();
}
coordinatorRef.current = await createCoordinator();
const coordinator = coordinatorRef.current;

// --- Operator sessions (cookie auth for the SPA; header-token remains for
// API clients) -----------------------------------------------------------

app.post("/api/session/login", authLimit, (req, res) => {
  const parsed = z.object({ token: z.string().min(1).max(256) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "token required" });
  const apiToken = process.env.PS_API_TOKEN;
  if (!apiToken) {
    return res.status(400).json({ error: "Session auth is not required in local mode." });
  }
  const supplied = parsed.data.token;
  const adminToken = process.env.PS_ADMIN_TOKEN;
  const isAdmin = Boolean(adminToken && safeTokenEqual(supplied, adminToken));
  const isOperator = safeTokenEqual(supplied, apiToken);
  if (!isAdmin && !isOperator) {
    store.audit({ type: "auth_event", detail: "Session login rejected (invalid token)" });
    return res.status(401).json({ error: "Invalid token." });
  }
  const sid = createSession(isAdmin ? "admin" : "operator");
  const secure = req.secure || process.env.NODE_ENV === "production";
  res.setHeader("Set-Cookie", sessionCookie(sid, secure));
  store.audit({ type: "auth_event", detail: `Session login (${isAdmin ? "admin" : "operator"})` });
  res.json({ authenticated: true, role: isAdmin ? "admin" : "operator" });
});

app.post("/api/session/logout", (req, res) => {
  destroySession(readSessionId(req));
  res.setHeader("Set-Cookie", clearSessionCookie);
  res.json({ authenticated: false });
});

app.get("/api/session", (req, res) => {
  const role = sessionRole(req);
  res.json({
    authenticated: Boolean(role),
    role,
    mode: process.env.PS_API_TOKEN ? "deployed" : "local",
  });
});

const PORT = Number(process.env.PORT) || 8787;
const PROJECT_ID = "demo-project";

const envSchema = z.enum(["baseline", "defended"]);
const runSchema = z
  .object({
    environment: envSchema,
    suiteId: z.string().max(64).optional(),
    testId: z.string().max(64).optional(),
    testIds: z.array(z.string().max(64)).min(1).max(20).optional(),
    repeat: z.number().int().min(1).max(5).optional(),
  })
  .refine(
    (v) => [v.suiteId, v.testId, v.testIds].filter(Boolean).length === 1,
    { message: "Provide exactly one of suiteId, testId or testIds." },
  );

function resolveSuiteTests(suiteId: string): string[] | null {
  const suite = SUITES.find((s) => s.id === suiteId);
  return suite ? suite.testIds : null;
}

/** Execute a suite or single test, persist the run + findings + audit events. */
function runHarness(environment: Environment, testIds: string[], suiteLabel: string, owner?: string): RunRecord {
  return store.batch(() => {
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
    owner,
  };
  const findings = findingsFromRun(run, results);
  store.addRun(run);
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
  });
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
    auth: {
      mode: process.env.PS_API_TOKEN ? "deployed" : "local",
      sessionEnabled: true,
    },
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

app.post("/api/runs", runsLimit, requireApiToken, (req, res) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request" });
  }
  const { environment, suiteId, testId, testIds: customIds, repeat = 1 } = parsed.data;

  let testIds: string[];
  let suiteLabel: string;
  if (customIds) {
    const unknown = customIds.filter((tid) => !getTestCase(tid));
    if (unknown.length) {
      return res.status(404).json({ error: `Unknown test(s): ${unknown.join(", ")}` });
    }
    testIds = [...new Set(customIds)];
    suiteLabel = "custom";
  } else if (testId) {
    if (!getTestCase(testId)) return res.status(404).json({ error: `Unknown test '${testId}'` });
    testIds = [testId];
    suiteLabel = "single";
  } else {
    const ids = resolveSuiteTests(suiteId!);
    if (!ids) return res.status(404).json({ error: `Unknown suite '${suiteId}'` });
    testIds = ids;
    suiteLabel = suiteId!;
  }

  // Repetitions are recorded as independent executions (documented metric
  // semantics — duplicates are real data, not deduped).
  const expanded = repeat > 1 ? Array.from({ length: repeat }, () => testIds).flat() : testIds;
  try {
    res.json(runHarness(environment, expanded, suiteLabel, ownerOf(req)));
  } catch {
    res.status(500).json({ error: "Harness execution failed" });
  }
});

app.get("/api/runs", (req, res) => {
  // Deployed mode: callers see only their own runs (admin sees all).
  const all = process.env.PS_API_TOKEN
    ? store.listRuns().filter((r) => canAccess(req, r.owner))
    : store.listRuns();
  res.json(
    all.map((r) => ({
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
  if (!run || !canAccess(req, run.owner)) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

app.get("/api/runs/:id/report", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run || !canAccess(req, run.owner)) return res.status(404).json({ error: "Run not found" });
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

app.patch("/api/findings/:id", requireApiToken, (req, res) => {
  const parsed = findingPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid status" });
  const f = store.updateFinding(req.params.id, { status: parsed.data.status });
  if (!f) return res.status(404).json({ error: "Finding not found" });
  res.json(f);
});

app.post("/api/findings/:id/rerun", runsLimit, requireApiToken, (req, res) => {
  const finding = store.getFinding(req.params.id);
  if (!finding) return res.status(404).json({ error: "Finding not found" });
  const parentRun = store.getRun(finding.runId);
  if (!canAccess(req, parentRun?.owner)) return res.status(403).json({ error: "Forbidden" });
  const run = runHarness(finding.environment, [finding.testId], "rerun", ownerOf(req));
  const result = run.results[0];
  if (result.verdict === "pass") {
    store.updateFinding(finding.id, { status: "resolved" });
  }
  res.json({ run, result, finding: store.getFinding(finding.id) });
});

app.post("/api/investigate", investigateLimit, requireApiToken, async (req, res) => {
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

// --- AI-assisted evaluation (advisory only; deterministic results stay authoritative) ---

app.post("/api/runs/:id/analysis", investigateLimit, requireApiToken, async (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run || !canAccess(req, run.owner)) return res.status(404).json({ error: "Run not found" });
  const findings = store.listFindings().filter((f) => f.runId === run.id);

  store.audit({
    type: "ai_analysis",
    environment: run.environment,
    runId: run.id,
    detail: `AI run analysis requested for ${run.id}`,
  });

  try {
    const out = await analyzeRunWithGemini(run, findings);
    res.json(out);
  } catch (err) {
    const unavailable = err instanceof GeminiUnavailable;
    res.status(unavailable ? 503 : 502).json({
      error: unavailable
        ? (err as Error).message
        : "AI analysis failed. The deterministic results remain authoritative.",
    });
  }
});

const planSchema = z.object({ scope: z.string().min(1).max(500) });

app.post("/api/plans", investigateLimit, requireApiToken, async (req, res) => {
  const parsed = planSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "scope (1-500 chars) required" });
  }
  try {
    const out = await planTestsWithGemini(parsed.data.scope);
    store.audit({
      type: "ai_plan",
      detail: `AI test plan generated: ${out.recommendedTestIds.length} recommended, ${out.ignoredTestIds.length} ignored`,
    });
    res.json(out);
  } catch (err) {
    const unavailable = err instanceof GeminiUnavailable;
    res.status(unavailable ? 503 : 502).json({
      error: unavailable
        ? (err as Error).message
        : "AI planning failed. The fixture catalog and deterministic harness are unaffected.",
    });
  }
});

// --- Red-team agent ---------------------------------------------------------

const agentSchema = z.object({
  environment: envSchema,
  preset: z.enum(["quick", "standard", "deep"]),
});

app.post("/api/agent/sessions", agentLimit, requireApiToken, async (req, res) => {
  const parsed = agentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Provide environment and preset (quick|standard|deep)" });
  }
  const owner = ownerOf(req);
  const { environment, preset } = parsed.data;

  // --- Idempotency-Key (optional, process-local) ---
  // sessionId is allocated BEFORE the atomic reserve so in-flight duplicates
  // replay the same id.
  const sessionId = id("agent");
  const idemHeader = req.get("Idempotency-Key");
  let scopeKey: string | null = null;
  if (idemHeader !== undefined) {
    if (!IDEM_KEY_RE.test(idemHeader)) {
      return res.status(400).json({ error: "Idempotency-Key must be 8-128 chars of [A-Za-z0-9_-]" });
    }
    const fingerprint = requestFingerprint(parsed.data);
    scopeKey = idemScope(owner, "agent_sessions", idemHeader);
    let reserved;
    try {
      reserved = await coordinator.reserveIdem({ scopeKey, fingerprint, sessionId, ttlMs: 60_000 });
    } catch {
      // Coordination backend unavailable → fail closed, no session created.
      return res.status(503).json({ error: "Coordination backend unavailable." });
    }
    if (reserved.state === "conflict") {
      return res.status(409).json({ error: "Idempotency-Key was already used with a different request." });
    }
    if (reserved.state === "replay" || reserved.state === "in-flight") {
      const existingSession = reserved.sessionId
        ? store.getAgentSession(reserved.sessionId)
        : undefined;
      if (existingSession) {
        // Replay — no new session, no slot, no duplicate audit event.
        return res.status(200).set("Idempotency-Replayed", "true").json(existingSession);
      }
      // In-flight sibling hasn't persisted yet, or its record was trimmed:
      // return the id so the client can poll the same session.
      if (reserved.sessionId) {
        return res
          .status(202)
          .set("Idempotency-Replayed", "true")
          .json({ id: reserved.sessionId, status: "running" });
      }
      // Reserved sibling didn't report an id — ask the client to retry.
      return res.status(409).json({ error: "Duplicate request in progress." });
    }
    // "fresh" — we own the slot; finalize on success, abandon on failure.
  }

  // Read-only precheck only — runAgent is the sole owner of slot
  // acquire/release; a race past this check surfaces as an honest
  // 'concurrency_limit' session error, never a leaked slot.
  if (ownerActiveCount(owner) >= MAX_CONCURRENT_PER_OWNER) {
    if (scopeKey) await coordinator.abandonIdem(scopeKey).catch(() => {});
    return res.status(429).json({ error: "Concurrent session limit reached for this client." });
  }

  const session = {
    id: sessionId,
    environment,
    preset,
    status: "running" as const,
    phase: "plan" as const,
    currentStrategy: null,
    attemptedTestIds: [],
    successfulTestIds: [],
    blockedCount: 0,
    consecutiveBlocks: 0,
    findings: [] as string[],
    trace: [],
    budget: { maxSteps: PRESETS[preset].maxSteps, maxMs: PRESETS[preset].maxMs, stepsUsed: 0, startedAt: new Date().toISOString() },
    planningSource: "deterministic" as const,
    stopReason: null,
    createdAt: new Date().toISOString(),
    seed: sessionId,
    owner,
  };
  // Persist BEFORE launching so the first onStep update has a row to hit.
  try {
    store.batch(() => {
      store.addAgentSession(session);
      store.audit({
        type: "agent_session",
        environment,
        detail: `Agent session ${sessionId} started (${PRESETS[preset].label})`,
      });
    });
  } catch {
    if (scopeKey) await coordinator.abandonIdem(scopeKey).catch(() => {});
    return res.status(500).json({ error: "Failed to create agent session" });
  }
  if (scopeKey) await coordinator.finalizeIdem(scopeKey).catch(() => {});

  // Run asynchronously — the client polls for progress. Pacing is simulated
  // for observability; every step executes the real deterministic engine.
  const done = runAgent({
    sessionId,
    environment,
    preset,
    owner,
    coordinator,
    onStep: (s) => {
      store.updateAgentSession(s.id, {
        phase: s.phase,
        currentStrategy: s.currentStrategy,
        trace: s.trace,
        budget: s.budget,
        attemptedTestIds: s.attemptedTestIds,
        successfulTestIds: s.successfulTestIds,
        blockedCount: s.blockedCount,
        planningSource: s.planningSource,
      });
    },
  }).then(({ session, results }) => {
    // Rejected sessions (e.g. raced concurrency limit) have no results —
    // persist their terminal state only, no synthetic run.
    if (results.length === 0 && session.status === "error") {
      store.updateAgentSession(session.id, {
        status: session.status,
        stopReason: session.stopReason,
        trace: session.trace,
      });
      return;
    }
    // Persist the session's executions as a normal run so findings, graph,
    // reports and forensics all work uniformly.
    const testMap = new Map(TEST_CASES.map((t) => [t.id, t]));
    const scored = toScoredResults(results, testMap);
    const run: RunRecord = {
      id: id("run"),
      projectId: PROJECT_ID,
      environment,
      suite: "agent",
      startedAt: session.budget.startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(session.budget.startedAt).getTime(),
      results,
      metrics: computeMetrics(scored.results, { unknownTestIds: scored.unknownTestIds.length }),
      agentSessionId: session.id,
    };
    const fs = findingsFromRun(run, results);
    store.batch(() => {
      store.addRun(run);
      if (fs.length) store.addFindings(fs);
      store.updateAgentSession(session.id, {
        runId: run.id,
        findings: fs.map((f) => f.id),
        status: session.status,
        stopReason: session.stopReason,
        trace: session.trace,
        budget: session.budget,
      });
      store.audit({
        type: "agent_session",
        environment,
        runId: run.id,
        detail: `Agent session ${session.id} ${session.status}: ${session.stopReason} — ${session.budget.stepsUsed} steps, ${session.successfulTestIds.length} verified success(es)`,
      });
    });
  }).catch((err) => {
    store.updateAgentSession(sessionId, {
      status: "error",
      stopReason: String((err as Error)?.message ?? err).slice(0, 200),
    });
  });
  void done;

  res.status(202).json(store.getAgentSession(sessionId));
});

app.get("/api/agent/sessions", (req, res) => {
  // Deployed mode: callers see only their own sessions (admin sees all).
  const sessions = process.env.PS_API_TOKEN
    ? store.listAgentSessions().filter((s) => canAccess(req, s.owner))
    : store.listAgentSessions();
  res.json(sessions);
});

app.get("/api/agent/sessions/:id", (req, res) => {
  const s = store.getAgentSession(req.params.id);
  if (!s || !canAccess(req, s.owner)) return res.status(404).json({ error: "Session not found" });
  res.json(s);
});

app.post("/api/agent/sessions/:id/cancel", requireApiToken, (req, res) => {
  const s = store.getAgentSession(req.params.id);
  if (!s || !canAccess(req, s.owner)) return res.status(404).json({ error: "Session not found" });
  if (s.status !== "running") {
    return res.status(409).json({ error: `Session is ${s.status}, not running` });
  }
  cancelSession(s.id);
  // Persist the cancellation intent — the in-memory flag is process-local,
  // but the recorded intent survives into the audit trail and the session
  // row for observability.
  store.updateAgentSession(s.id, { stopReason: "cancel_requested" });
  store.audit({ type: "agent_session", detail: `Agent session ${s.id} cancel requested` });
  res.json({ ok: true });
});

// --- Attack graph ------------------------------------------------------------

app.get("/api/runs/:id/graph", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run || !canAccess(req, run.owner)) return res.status(404).json({ error: "Run not found" });
  const testMap = new Map(TEST_CASES.map((t) => [t.id, t]));
  res.json(buildAttackGraph(run, testMap, store.listFindings()));
});

// --- Defense effectiveness lab ------------------------------------------------

app.get("/api/defense-lab/compare", (req, res) => {
  const q = z.object({ a: z.string().min(1).max(64), b: z.string().min(1).max(64) }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Both runs 'a' and 'b' are required" });
  const a = store.getRun(q.data.a);
  const b = store.getRun(q.data.b);
  if (!a || !b || !canAccess(req, a.owner) || !canAccess(req, b.owner)) {
    return res.status(404).json({ error: "Both runs 'a' and 'b' are required" });
  }
  const testMap = new Map(TEST_CASES.map((t) => [t.id, t]));
  const resB = new Map(b.results.map((r) => [r.testId, r]));

  const rows = a.results.map((ra) => {
    const rb = resB.get(ra.testId);
    const test = testMap.get(ra.testId);
    return {
      testId: ra.testId,
      title: test?.title ?? ra.testId,
      label: test?.label ?? "invalid",
      category: test?.category ?? "unknown",
      a: { verdict: ra.verdict, blocked: ra.blocked, canaryLeaked: ra.canaryLeaked, actionExecuted: ra.actionExecuted, durationMs: ra.durationMs },
      b: rb
        ? { verdict: rb.verdict, blocked: rb.blocked, canaryLeaked: rb.canaryLeaked, actionExecuted: rb.actionExecuted, durationMs: rb.durationMs }
        : null,
      // Regression: previously neutralized/handled → now fails.
      regression: rb ? ra.verdict === "pass" && rb.verdict === "fail" : null,
      latencyDeltaMs: rb ? rb.durationMs - ra.durationMs : null,
    };
  });

  res.json({
    a: { id: a.id, environment: a.environment, suite: a.suite, metrics: a.metrics, startedAt: a.startedAt },
    b: { id: b.id, environment: b.environment, suite: b.suite, metrics: b.metrics, startedAt: b.startedAt },
    rows,
    regressions: rows.filter((r) => r.regression === true).length,
    missingInB: rows.filter((r) => r.b === null).length,
    note: "Missing results are reported, never counted as blocked attacks.",
  });
});

// --- Forensics -----------------------------------------------------------------

app.get("/api/findings/:id/forensics", (req, res) => {
  const finding = store.getFinding(req.params.id);
  if (!finding) return res.status(404).json({ error: "Finding not found" });
  const run = store.getRun(finding.runId);
  if (!canAccess(req, run?.owner)) return res.status(404).json({ error: "Finding not found" });
  const test = getTestCase(finding.testId);
  if (!run || !test) return res.status(404).json({ error: "Associated run/test not found" });
  res.json(buildForensicRecord(finding, run, test));
});

app.get("/api/audit/verify", (_req, res) => {
  const result = store.verifyAuditChain();
  // Refresh the signed checkpoint so future verifications compare against
  // a state sealed *separate* from the mutable store file.
  const refreshed = store.auditCheckpoint();
  res.json({
    ...result,
    checkpoint: result.checkpoint,
    signed: Boolean(refreshed.sig),
  });
});

// --- Runtime firewall ------------------------------------------------------------

app.get("/api/firewall/policies", (_req, res) => {
  res.json({
    rules: POLICY_RULES,
    toolAllowlist: TOOL_ALLOWLIST,
    approvalRequired: [...APPROVAL_REQUIRED],
    modes: {
      test: "POST /api/firewall/evaluate returns a decision; nothing executes.",
      integration: "the defended engine authorizes actions through the same evaluate() code path.",
    },
    limitations:
      "Simulated enforcement over a mock tool catalog — real enforcement semantics " +
      "(allowlist, argument validation, approvals, fail-closed) but no real tools execute.",
  });
});

const firewallEvalSchema = z.object({
  tool: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
  approvalToken: z.string().max(128).optional(),
  sessionId: z.string().max(128).optional(),
});

app.post("/api/firewall/evaluate", runsLimit, requireApiToken, (req, res) => {
  const parsed = firewallEvalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Provide { tool, args?, approvalToken?, sessionId? }" });
  }
  const { tool, args = {}, approvalToken, sessionId } = parsed.data;
  const decision = firewallEvaluate({
    tool,
    args,
    approvalToken,
    sessionId,
    correlationId: req.get("x-correlation-id") ?? `api-${Date.now().toString(36)}`,
  });
  store.audit({
    type: "firewall_decision",
    detail: `firewall ${decision.result} ${decision.policyId}: ${tool} — ${decision.reason}`,
  });
  res.json(decision);
});

const approvalSchema = z.object({
  tool: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
});

app.post("/api/firewall/approvals", runsLimit, requireApiToken, (req, res) => {
  const parsed = approvalSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Provide { tool, args? }" });
  }
  if (!APPROVAL_REQUIRED.has(parsed.data.tool)) {
    return res.status(400).json({ error: `Tool '${parsed.data.tool}' does not require approval` });
  }
  const approval = issueApproval(parsed.data.tool, parsed.data.args ?? {});
  res.status(201).json(approval);
});

// --- Benchmark arena --------------------------------------------------------------

app.get("/api/benchmarks", (_req, res) => {
  res.json({
    runs: store.listBenchmarkRuns(),
    suites: SUITES,
    scoringFormula:
      "score = 100 * Σ w_i·component_i / Σ w_i(available) where components = " +
      "(1-ASR), (1-BFRR), blockRate, F1. Null denominators are excluded and " +
      "weights renormalized — never fabricated.",
    note: "Benchmarks compare deterministic configurations only — not different live models.",
  });
});

const benchRunSchema = z.object({
  environment: envSchema,
  suiteId: z.string().max(64).default("full"),
  weights: z
    .object({
      attackSuccess: z.number().min(0).max(1).optional(),
      falseRefusal: z.number().min(0).max(1).optional(),
      blockRate: z.number().min(0).max(1).optional(),
      f1: z.number().min(0).max(1).optional(),
    })
    .partial()
    .optional(),
});

app.post("/api/benchmarks/run", runsLimit, requireApiToken, (req, res) => {
  const parsed = benchRunSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Provide { environment, suiteId?, weights? }" });
  }
  const { environment, suiteId, weights } = parsed.data;
  const ids = resolveSuiteTests(suiteId);
  if (!ids) return res.status(404).json({ error: `Unknown suite '${suiteId}'` });

  const run = runHarness(environment, ids, `benchmark:${suiteId}`, ownerOf(req));
  const bench = toBenchmarkRun(
    { id: run.id, suite: suiteId, environment, metrics: run.metrics, results: run.results },
    weights as Partial<BenchmarkWeights>,
  );
  store.addBenchmarkRun(bench);
  store.audit({
    type: "benchmark_run",
    environment,
    runId: run.id,
    detail: `Benchmark ${bench.id} — score ${bench.score ?? "n/a"} (fingerprint ${bench.fingerprint})`,
  });
  res.status(201).json({ run, benchmark: bench });
});

app.get("/api/benchmarks/compare", (req, res) => {
  const q = z.object({ a: z.string().min(1).max(64), b: z.string().min(1).max(64) }).safeParse(req.query);
  if (!q.success) return res.status(400).json({ error: "Both benchmark ids 'a' and 'b' are required" });
  const a = store.getBenchmarkRun(q.data.a);
  const b = store.getBenchmarkRun(q.data.b);
  if (!a || !b) return res.status(404).json({ error: "Both benchmark ids 'a' and 'b' are required" });
  res.json({
    a,
    b,
    deltas: {
      score: a.score !== null && b.score !== null ? b.score - a.score : null,
      attackSuccessRate:
        a.metrics.attackSuccessRate !== null && b.metrics.attackSuccessRate !== null
          ? b.metrics.attackSuccessRate - a.metrics.attackSuccessRate
          : null,
      defenseBlockRate:
        a.metrics.defenseBlockRate !== null && b.metrics.defenseBlockRate !== null
          ? b.metrics.defenseBlockRate - a.metrics.defenseBlockRate
          : null,
    },
    sameConfiguration: a.fingerprint === b.fingerprint,
  });
});

// --- HTML report export ------------------------------------------------------------

app.get("/api/runs/:id/report.html", (req, res) => {
  const run = store.getRun(req.params.id);
  if (!run || !canAccess(req, run.owner)) return res.status(404).json({ error: "Run not found" });
  const report = buildReport(run, store.listFindings());
  const esc = (s: unknown) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const rows = report.results
    .map(
      (r) =>
        `<tr><td>${esc(r.testId)}</td><td>${esc(r.title)}</td><td>${esc(r.category)}</td>` +
        `<td>${esc(r.label)}</td><td>${esc(r.verdict)}</td><td>${r.durationMs}ms</td></tr>`,
    )
    .join("");
  const findings = report.findings
    .map(
      (f) =>
        `<li><b>[${esc(f.severity)}]</b> ${esc(f.title)} — <code>${esc(f.testId)}</code><br/>` +
        `<small>${esc(f.description)}</small><br/><small><b>Remediation:</b> ${esc(f.remediation)}</small></li>`,
    )
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PromptShield report ${esc(run.id)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;color:#1a2433;font-size:13px}
h1{font-size:20px}h2{font-size:15px;margin-top:1.6em}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #c8d2e0;padding:5px 8px;text-align:left;font-size:12px}
code{font-family:ui-monospace,monospace}.meta{color:#51606f;font-size:12px}
.warn{background:#fdf3e3;border:1px solid #e6c877;padding:8px 10px;border-radius:6px;font-size:12px}
@media print{body{margin:0}}</style></head><body>
<h1>PromptShield AI — Security Evaluation Report</h1>
<p class="meta">Run <code>${esc(run.id)}</code> · environment <b>${esc(run.environment)}</b> · suite <code>${esc(run.suite)}</code> · ${esc(run.startedAt)}</p>
<div class="warn"><b>Methodology &amp; limitations:</b> ${esc(report.limitations.join(" "))}</div>
<h2>Metrics</h2><p>ASR ${esc(report.metrics.attackSuccessRate ?? "n/a")} · block rate ${esc(report.metrics.defenseBlockRate ?? "n/a")} · BFRR ${esc(report.metrics.benignFalseRefusalRate ?? "n/a")} · F1 ${esc(report.metrics.f1 ?? "n/a")} · ${report.metrics.total} tests</p>
<h2>Results</h2><table><tr><th>Test</th><th>Title</th><th>Category</th><th>Label</th><th>Verdict</th><th>Time</th></tr>${rows}</table>
<h2>Findings (${report.findings.length})</h2><ul>${findings || "<li>none</li>"}</ul>
<p class="meta">Generated ${esc(report.generatedAt)} · deterministic simulation — not a live-model measurement. Print to PDF for a document copy.</p>
</body></html>`;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  store.audit({ type: "report_exported", environment: run.environment, runId: run.id, detail: `HTML report exported for run ${run.id}` });
  res.send(html);
});

app.get("/api/audit", (_req, res) => {
  res.json(store.listAudit());
});

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const resetSchema = z.object({ confirm: z.literal("RESET") });

function requireResetAuthorization(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  const adminToken = process.env.PS_ADMIN_TOKEN;
  if (adminToken) {
    const supplied = req.get("x-admin-token") ?? "";
    if (supplied && safeTokenEqual(supplied, adminToken)) return next();
    // Admin-session cookie path (SPA) — same origin guard via requireApiToken.
    if (sessionRole(req) === "admin") return next();
    return res.status(403).json({ error: "Reset requires a valid admin token." });
  }
  if (!LOOPBACK.has(req.ip ?? "")) {
    return res.status(403).json({ error: "Reset is restricted to local clients." });
  }
  next();
}

app.post("/api/reset", resetLimit, requireApiToken, requireResetAuthorization, (req, res) => {
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
    if (process.env.NODE_ENV === "production" && !process.env.PS_API_TOKEN) {
      console.warn(
        "[PromptShield] WARNING: NODE_ENV=production but PS_API_TOKEN is unset — " +
          "mutating endpoints run in unauthenticated LOCAL DEMO MODE. Set PS_API_TOKEN " +
          "for any shared or deployed environment.",
      );
    }
  });
}
