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
  | "investigation_failed"
  | "ai_analysis"
  | "ai_plan"
  | "agent_session"
  | "firewall_decision"
  | "benchmark_run";

export interface SuggestedTest {
  title: string;
  input: string;
  rationale: string;
}

/**
 * AI-generated review of a deterministic run. Advisory only — never feeds
 * metrics or verdicts.
 */
export interface AiRunAnalysis {
  runId: string;
  environment: Environment;
  model: string;
  generatedAt: string;
  isAiGenerated: true;
  methodology: string;
  attackIntent: string;
  assessment: "agree" | "disagree" | "uncertain";
  reasoning: string;
  evidenceSummary: string;
  suggestedTests: SuggestedTest[];
  mitigations: string[];
}

/** Bounded AI test plan: model nominates existing fixture IDs only. */
export interface AiTestPlan {
  scope: string;
  model: string;
  generatedAt: string;
  isAiGenerated: true;
  methodology: string;
  rationale: string;
  recommendedTestIds: string[];
  /** Model-suggested IDs that failed the catalog allowlist — dropped. */
  ignoredTestIds: string[];
  warnings: string[];
}

// --- Red-team agent --------------------------------------------------------

export type AgentPreset = "quick" | "standard" | "deep";
export type AgentPhase =
  | "plan" | "select" | "execute" | "observe" | "evaluate" | "update" | "done";
export type AgentStatus = "running" | "completed" | "stopped" | "error";

export interface AgentStep {
  step: number;
  at: string;
  phase: AgentPhase;
  strategyId?: string;
  testId?: string;
  outcome?: "success" | "blocked" | "other";
  durationMs?: number;
  detail: string;
}

export interface AgentSession {
  id: string;
  environment: Environment;
  preset: AgentPreset;
  status: AgentStatus;
  phase: AgentPhase;
  currentStrategy: string | null;
  attemptedTestIds: string[];
  successfulTestIds: string[];
  blockedCount: number;
  consecutiveBlocks: number;
  findings: string[];
  trace: AgentStep[];
  budget: { maxSteps: number; maxMs: number; stepsUsed: number; startedAt: string };
  planningSource: "deterministic" | "gemini";
  stopReason: string | null;
  createdAt: string;
  seed: string;
  /** Set when the session's aggregate run has been persisted. */
  runId?: string;
}

// --- Attack graph ----------------------------------------------------------

export type GraphNodeType =
  | "entry"
  | "untrusted_input"
  | "technique"
  | "action_attempt"
  | "data_access"
  | "policy_decision"
  | "outcome";

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  label: string;
  testId?: string;
  ref?: string;
  outcome?: string;
  evidence?: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
  /** true = relationship inferred from sequence, not directly recorded */
  inferred?: boolean;
}

export interface AttackChain {
  id: string;
  label: string;
  severity: Finding["severity"];
  steps: string[]; // node ids in order
  summary: string;
  evidenceRefs: string[];
}

export interface AttackGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  chains: AttackChain[];
}

// --- Forensics -------------------------------------------------------------

export interface ForensicRecord {
  findingId: string;
  runId: string;
  sessionId?: string;
  traceId: string;
  testId: string;
  severity: Finding["severity"];
  confidence: "high" | "medium" | "low";
  category: Finding["category"];
  input: string;
  defense: { environment: Environment; description: string };
  outcome: {
    verdict: Verdict;
    canaryLeaked: boolean;
    privateDataLeaked: boolean;
    actionExecuted: boolean;
    blocked: boolean;
  };
  toolAttempts: string[];
  policyDecisions: { ruleId: string; outcome: string; reason: string }[];
  timeline: { at: string; event: string; detail: string }[];
  rootCause: string;
  impact: string;
  remediation: {
    control: string;
    suggestedChange: string;
    regressionTest: string;
    verifySteps: string[];
    source: "deterministic" | "ai";
  };
  evidence: EvidenceItem[];
  reproduction: string[];
  replayEligible: boolean;
  verificationStatus: string;
  integrity: { note: string; hashPrefix?: string };
}

// --- Benchmarks ------------------------------------------------------------

export interface BenchmarkWeights {
  attackSuccess: number;
  falseRefusal: number;
  blockRate: number;
  f1: number;
}

export interface BenchmarkRun {
  id: string;
  runId: string;
  suiteId: string;
  environment: Environment;
  fingerprint: string;
  fixtureVersion: string;
  evaluatorVersion: string;
  runtime: string;
  weights: BenchmarkWeights;
  score: number | null;
  metrics: {
    attackSuccessRate: number | null;
    benignFalseRefusalRate: number | null;
    defenseBlockRate: number | null;
    f1: number | null;
    total: number;
    errors: number;
  };
  at: string;
  reproducible: "exact" | "approximate";
}

export interface AuditEvent {
  id: string;
  type: AuditEventType;
  at: string;
  runId?: string;
  testId?: string;
  findingId?: string;
  environment?: Environment;
  detail: string;
  /** Tamper-evidence hash chaining this event to the previous one. */
  hash?: string;
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
