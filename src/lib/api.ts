import type {
  AgentSession,
  AiRunAnalysis,
  AiTestPlan,
  AttackGraph,
  AuditEvent,
  BenchmarkRun,
  Environment,
  ForensicRecord,
  ExecutionResult,
  Finding,
  IntegrationStatus,
  InvestigationResponse,
  OverviewStats,
  RunMetrics,
  RunRecord,
  SecurityReport,
  SessionStatus,
  SuiteDefinition,
  TestCase,
  Verdict,
} from "@shared/types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface RunSummary {
  id: string;
  environment: Environment;
  suite: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  metrics: RunMetrics;
  resultCount: number;
}

export interface Catalog {
  testCases: TestCase[];
  suites: SuiteDefinition[];
  environments: Record<Environment, { name: string; description: string }>;
}

export interface DefenseCompare {
  a: { id: string; environment: string; suite: string; metrics: RunMetrics; startedAt: string };
  b: { id: string; environment: string; suite: string; metrics: RunMetrics; startedAt: string };
  rows: {
    testId: string;
    title: string;
    label: string;
    category: string;
    a: { verdict: Verdict; blocked: boolean; canaryLeaked: boolean; actionExecuted: boolean; durationMs: number };
    b: { verdict: Verdict; blocked: boolean; canaryLeaked: boolean; actionExecuted: boolean; durationMs: number } | null;
    regression: boolean | null;
    latencyDeltaMs: number | null;
  }[];
  regressions: number;
  missingInB: number;
  note: string;
}

export interface FirewallDecision {
  id: string;
  result: "allow" | "deny" | "approval_required";
  policyId: string;
  reason: string;
  tool: string;
  at: string;
  correlationId: string;
}

export interface FirewallPolicies {
  rules: { id: string; name: string; description: string }[];
  toolAllowlist: string[];
  approvalRequired: string[];
  modes: { test: string; integration: string };
  limitations: string;
}

export interface BenchmarkIndex {
  runs: BenchmarkRun[];
  suites: { id: string; name: string }[];
  scoringFormula: string;
  note: string;
}

export interface BenchmarkCompare {
  a: BenchmarkRun;
  b: BenchmarkRun;
  deltas: { score: number | null; attackSuccessRate: number | null; defenseBlockRate: number | null };
  sameConfiguration: boolean;
}

export const api = {
  status: () => request<IntegrationStatus>("/api/health/status"),
  catalog: () => request<Catalog>("/api/tests"),
  overview: () => request<OverviewStats>("/api/overview"),
  listRuns: () => request<RunSummary[]>("/api/runs"),
  getRun: (id: string) => request<RunRecord>(`/api/runs/${id}`),
  getReport: (id: string) => request<SecurityReport>(`/api/runs/${id}/report`),
  runSuite: (environment: Environment, suiteId: string) =>
    request<RunRecord>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ environment, suiteId }),
    }),
  runTest: (environment: Environment, testId: string) =>
    request<RunRecord>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ environment, testId }),
    }),
  findings: (status?: string) =>
    request<Finding[]>(`/api/findings${status ? `?status=${status}` : ""}`),
  updateFinding: (id: string, status: Finding["status"]) =>
    request<Finding>(`/api/findings/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),
  rerunFinding: (id: string) =>
    request<{ run: RunRecord; result: ExecutionResult; finding: Finding }>(
      `/api/findings/${id}/rerun`,
      { method: "POST", body: "{}" },
    ),
  investigate: (findingId: string) =>
    request<InvestigationResponse>("/api/investigate", {
      method: "POST",
      body: JSON.stringify({ findingId }),
    }),
  runCustom: (environment: Environment, testIds: string[]) =>
    request<RunRecord>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ environment, testIds }),
    }),
  analyzeRun: (runId: string) =>
    request<AiRunAnalysis>(`/api/runs/${runId}/analysis`, {
      method: "POST",
      body: "{}",
    }),
  generatePlan: (scope: string) =>
    request<AiTestPlan>("/api/plans", {
      method: "POST",
      body: JSON.stringify({ scope }),
    }),

  // Red-team agent
  startAgent: (environment: Environment, preset: "quick" | "standard" | "deep") =>
    request<AgentSession>("/api/agent/sessions", {
      method: "POST",
      body: JSON.stringify({ environment, preset }),
    }),
  agentSession: (id: string) => request<AgentSession>(`/api/agent/sessions/${id}`),
  agentSessions: () => request<AgentSession[]>("/api/agent/sessions"),
  cancelAgent: (id: string) =>
    request<{ ok: true }>(`/api/agent/sessions/${id}/cancel`, {
      method: "POST",
      body: "{}",
    }),

  // Attack graph / defense lab / forensics
  runGraph: (runId: string) => request<AttackGraph>(`/api/runs/${runId}/graph`),
  defenseCompare: (a: string, b: string) =>
    request<DefenseCompare>(`/api/defense-lab/compare?a=${a}&b=${b}`),
  forensics: (findingId: string) =>
    request<ForensicRecord>(`/api/findings/${findingId}/forensics`),
  auditVerify: () =>
    request<{ valid: boolean; checked: number; firstBadId?: string }>("/api/audit/verify"),

  // Firewall
  firewallPolicies: () => request<FirewallPolicies>("/api/firewall/policies"),
  firewallEvaluate: (body: {
    tool: string;
    args?: Record<string, unknown>;
    approvalToken?: string;
    sessionId?: string;
  }) =>
    request<FirewallDecision>("/api/firewall/evaluate", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  firewallApprove: (tool: string, args?: Record<string, unknown>) =>
    request<{ token: string; expiresAt: string }>("/api/firewall/approvals", {
      method: "POST",
      body: JSON.stringify({ tool, args }),
    }),

  // Benchmarks
  benchmarks: () => request<BenchmarkIndex>("/api/benchmarks"),
  runBenchmark: (environment: Environment, suiteId = "full", weights?: Record<string, number>) =>
    request<{ run: RunRecord; benchmark: BenchmarkRun }>("/api/benchmarks/run", {
      method: "POST",
      body: JSON.stringify({ environment, suiteId, weights }),
    }),
  compareBenchmarks: (a: string, b: string) =>
    request<BenchmarkCompare>(`/api/benchmarks/compare?a=${a}&b=${b}`),
  audit: () => request<AuditEvent[]>("/api/audit"),
  reset: () =>
    request<{ ok: true }>("/api/reset", {
      method: "POST",
      body: JSON.stringify({ confirm: "RESET" }),
    }),
  session: () => request<SessionStatus>("/api/session"),
  login: (token: string) =>
    request<SessionStatus>("/api/session/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  logout: () => request<{ authenticated: false }>("/api/session/logout", { method: "POST" }),
};
