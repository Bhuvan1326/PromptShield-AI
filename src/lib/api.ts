import type {
  AuditEvent,
  Environment,
  ExecutionResult,
  Finding,
  IntegrationStatus,
  InvestigationResponse,
  OverviewStats,
  RunMetrics,
  RunRecord,
  SecurityReport,
  SuiteDefinition,
  TestCase,
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
  audit: () => request<AuditEvent[]>("/api/audit"),
  reset: () => request<{ ok: true }>("/api/reset", { method: "POST", body: "{}" }),
};
