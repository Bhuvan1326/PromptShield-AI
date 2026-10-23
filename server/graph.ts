import type {
  AttackChain,
  AttackGraph,
  ExecutionResult,
  Finding,
  GraphEdge,
  GraphNode,
  RunRecord,
  TestCase,
} from "../shared/types";

/**
 * ATTACK GRAPH — built exclusively from recorded execution events.
 * Every node/edge traces to a real result/decision/evidence item. Edges
 * marked `inferred` connect temporally adjacent observed events; they are
 * labeled as inference, never claimed as proven causality.
 */

const CATEGORY_TECHNIQUE: Record<string, string> = {
  benign: "benign request",
  prompt_injection: "prompt injection",
  canary_extraction: "canary extraction",
  unauthorized_action: "unauthorized tool invocation",
  robustness: "input-robustness probe",
};

function buildNodesForResult(test: TestCase, r: ExecutionResult): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const tid = r.testId;

  const push = (n: Omit<GraphNode, "id">, id?: string) => {
    const node: GraphNode = { id: id ?? `${tid}:${n.type}:${nodes.length}`, ...n };
    nodes.push(node);
    return node.id;
  };
  const link = (from: string, to: string, label: string, inferred = false) =>
    edges.push({ from, to, label, inferred });

  // Entry + input — observed.
  const entry = push({ type: "entry", label: `Test ${tid}`, testId: tid, ref: tid });
  const input = push({
    type: "untrusted_input",
    label: test.untrustedContent ? "untrusted embedded content" : "user input",
    testId: tid,
    evidence: [test.input.slice(0, 140)],
  });
  link(entry, input, "presents");

  // Technique — from the fixture's ground-truth category.
  const technique = push({
    type: "technique",
    label: CATEGORY_TECHNIQUE[test.category] ?? test.category,
    testId: tid,
  });
  link(input, technique, "attempts", true);

  // Action attempt — observed when the case requested one.
  let tail = technique;
  if (test.requestedAction) {
    const action = push({
      type: "action_attempt",
      label: `tool: ${test.requestedAction}`,
      testId: tid,
      outcome: r.actionExecuted ? "executed" : "blocked",
    });
    link(technique, action, "invokes");
    tail = action;
  }

  // Canary/data access — observed via outcome flags.
  if (r.canaryLeaked || r.privateDataLeaked) {
    const data = push({
      type: "data_access",
      label: r.canaryLeaked ? "canary disclosed" : "private data disclosed",
      testId: tid,
      outcome: "exposed",
    });
    link(tail, data, "reaches", true);
    tail = data;
  }

  // Policy decisions — each recorded guardrail decision is a real node.
  for (const d of r.decisions) {
    if (d.outcome === "allowed" && d.ruleId === "policy.default_allow") continue;
    const pd = push({
      type: "policy_decision",
      label: d.ruleId,
      testId: tid,
      outcome: d.outcome,
      evidence: [d.reason.slice(0, 160)],
    });
    link(tail, pd, d.outcome === "executed" ? "permitted by" : "decided by");
    tail = pd;
  }

  // Terminal outcome — observed verdict.
  const outcome = push({
    type: "outcome",
    label: `verdict: ${r.verdict}`,
    testId: tid,
    outcome: r.verdict,
  });
  link(tail, outcome, "results in");

  return { nodes, edges };
}

/** Chain detection over observed node sequences — no invented narrative. */
function detectChains(nodes: GraphNode[], findings: Finding[]): AttackChain[] {
  const chains: AttackChain[] = [];
  const byTest = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    if (!n.testId) continue;
    byTest.set(n.testId, [...(byTest.get(n.testId) ?? []), n]);
  }
  const findingByTest = new Map(findings.map((f) => [f.testId, f]));

  for (const [testId, ns] of byTest) {
    const has = (t: GraphNode["type"], outcome?: string) =>
      ns.find((n) => n.type === t && (!outcome || n.outcome === outcome));
    const outcomeNode = has("outcome");
    if (!outcomeNode || outcomeNode.outcome !== "fail") continue;

    const chainNodes: GraphNode[] = [
      has("untrusted_input"),
      has("technique"),
      has("action_attempt", "executed"),
      has("data_access", "exposed"),
      outcomeNode,
    ].filter((n): n is GraphNode => Boolean(n));

    const leaked = has("data_access", "exposed");
    const acted = has("action_attempt", "executed");
    if (!leaked && !acted) continue; // only verified compromise chains

    const finding = findingByTest.get(testId);
    chains.push({
      id: `chain-${testId}`,
      label: leaked ? "Injection → sensitive-data exposure" : "Injection → unauthorized action",
      severity: finding?.severity ?? "high",
      steps: chainNodes.map((n) => n.id),
      summary:
        `Untrusted input at ${testId} led through ${ns.find((n) => n.type === "technique")?.label} ` +
        `to a verified ${leaked ? "protected-data disclosure" : "unauthorized tool execution"} ` +
        `(verdict fail). All steps are observed events.`,
      evidenceRefs: [finding?.id ?? testId],
    });
  }
  return chains;
}

/** Build the graph for one run. */
export function buildAttackGraph(run: RunRecord, testById: Map<string, TestCase>, findings: Finding[]): AttackGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  for (const r of run.results) {
    const test = testById.get(r.testId);
    if (!test) continue;
    const part = buildNodesForResult(test, r);
    nodes.push(...part.nodes);
    edges.push(...part.edges);
  }
  return { nodes, edges, chains: detectChains(nodes, findings.filter((f) => f.runId === run.id)) };
}
