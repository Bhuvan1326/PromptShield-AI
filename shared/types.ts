export type Environment = "baseline" | "defended";

export type GroundTruthLabel = "attack" | "benign" | "invalid";

export type TestCategory =
  | "benign"
  | "prompt_injection"
  | "indirect_injection"
  | "data_extraction"
  | "unauthorized_action"
  | "robustness";

export type RiskLabel = "critical" | "high" | "medium" | "low" | "info";

export type Verdict = "pass" | "fail" | "inconclusive" | "error";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingStatus = "open" | "acknowledged" | "resolved";

export interface TestCase {
  id: string;
  title: string;
  description: string;
  category: TestCategory;
  label: GroundTruthLabel;
  risk: RiskLabel;
  /** User-visible prompt. */
  input: string;
  /** Untrusted embedded content for indirect-injection scenarios. */
  untrustedContent?: string;
  /** Simulated tool/action the input asks the assistant to invoke. */
  requestedAction?: string;
  expectation: {
    description: string;
    shouldBlock: boolean;
    mustNotLeakCanary: boolean;
    mustNotExecuteAction: boolean;
  };
}

export interface EvidenceItem {
  kind:
    | "prompt"
    | "response"
    | "defense_decision"
    | "canary_check"
    | "action_check"
    | "note";
  label: string;
  /** Sanitized evidence. Canary values are redacted before storage. */
  content: string;
}

export interface DefenseDecision {
  ruleId: string;
  outcome: "allowed" | "blocked" | "flagged" | "rejected" | "executed" | "simulated";
  reason: string;
}

export interface ExecutionResult {
  testId: string;
  verdict: Verdict;
  response: string;
  canaryLeaked: boolean;
  privateDataLeaked: boolean;
  actionExecuted: boolean;
  blocked: boolean;
  decisions: DefenseDecision[];
  durationMs: number;
  evidence: EvidenceItem[];
  errorMessage?: string;
}

export interface RunRecord {
  id: string;
  projectId: string;
  environment: Environment;
  suite: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  results: ExecutionResult[];
  metrics: RunMetrics;
}

export interface ConfusionMatrix {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export interface RunMetrics {
  total: number;
  scoredAttack: number;
  scoredBenign: number;
  invalid: number;
  inconclusive: number;
  errors: number;
  /** Results referencing test IDs not present in the fixture catalog —
   *  excluded from scoring rather than silently misclassified. */
  unknownTestIds: number;
  confusion: ConfusionMatrix;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  attackSuccessRate: number | null;
  defenseBlockRate: number | null;
  benignFalseRefusalRate: number | null;
  medianLatencyMs: number | null;
  latencyDistributionMs: number[];
}

export interface Finding {
  id: string;
  testId: string;
  runId: string;
  environment: Environment;
  severity: FindingSeverity;
  status: FindingStatus;
  title: string;
  category: TestCategory;
  description: string;
  reproductionSteps: string[];
  evidence: EvidenceItem[];
  remediation: string;
  createdAt: string;
}

export type AuditEventType =
  | "run_created"
  | "run_finished"
  | "test_executed"
  | "finding_created"
  | "report_exported"
  | "data_reset"
  | "investigation_requested"
  | "investigation_completed"
  | "investigation_failed";

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  at: string;
  runId?: string;
  testId?: string;
  findingId?: string;
  environment?: Environment;
  detail: string;
}

export interface OverviewStats {
  totalRuns: number;
  totalTests: number;
  confirmedAttackSuccesses: number;
  attackSuccessRate: number | null;
  defenseBlockRate: number | null;
  benignFalseRefusalRate: number | null;
  medianLatencyMs: number | null;
  inconclusive: number;
  errors: number;
  openFindings: number;
  byEnvironment: {
    baseline: RunMetrics | null;
    defended: RunMetrics | null;
  };
  categoryBreakdown: { category: TestCategory; failed: number; total: number }[];
  recentRuns: {
    id: string;
    environment: Environment;
    suite: string;
    at: string;
    passed: number;
    failed: number;
    total: number;
  }[];
  topFindings: Finding[];
}

export interface SecurityReport {
  reportVersion: string;
  generatedAt: string;
  tool: string;
  disclaimer: string;
  project: { id: string; name: string; environment: Environment };
  run: {
    id: string;
    suite: string;
    startedAt: string;
    finishedAt: string;
  };
  testConfiguration: {
    environment: Environment;
    description: string;
  };
  results: {
    testId: string;
    title: string;
    category: TestCategory;
    label: GroundTruthLabel;
    expectation: string;
    verdict: Verdict;
    durationMs: number;
    evidenceSummary: string[];
  }[];
  metrics: RunMetrics;
  denominators: Record<string, string>;
  findings: Finding[];
  limitations: string[];
}

export interface IntegrationStatus {
  gemini: {
    state: "configured" | "missing_key";
    model: string;
    message: string;
  };
  storage: { state: "ready" | "error"; kind: string };
  engine: { state: "ready"; testCases: number };
}

export interface InvestigationResponse {
  findingId?: string;
  runId: string;
  model: string;
  generatedAt: string;
  /** AI-generated explanation — NOT a verified verdict. */
  explanation: string;
  observedEvidence: string[];
  recommendedMitigations: string[];
  uncertainty: string;
  isAiGenerated: true;
}

export interface SuiteDefinition {
  id: string;
  name: string;
  description: string;
  testIds: string[];
}

export interface DemoProject {
  id: string;
  name: string;
  environment: Environment;
}
