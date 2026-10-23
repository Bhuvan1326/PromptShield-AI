import type {
  OverviewStats,
  RunMetrics,
  RunRecord,
  TestCategory,
} from "../shared/types";
import { computeMetrics, toScoredResults } from "../shared/metrics";
import { getTestCase, TEST_CASES } from "./engine/fixtures";
import { store } from "./store";

const CATEGORIES: TestCategory[] = [
  "benign",
  "prompt_injection",
  "indirect_injection",
  "data_extraction",
  "unauthorized_action",
  "robustness",
];

const testMap = new Map(TEST_CASES.map((t) => [t.id, t]));

export function buildOverview(): OverviewStats {
  const runs = store.listRuns();
  const findings = store.listFindings();

  const allResults = runs.flatMap((r) => r.results);
  const allScored = toScoredResults(allResults, testMap);
  const overall = computeMetrics(allScored.results, {
    unknownTestIds: allScored.unknownTestIds.length,
  });

  const envMetrics = (env: RunRecord["environment"]): RunMetrics | null => {
    const envResults = runs.filter((r) => r.environment === env).flatMap((r) => r.results);
    if (envResults.length === 0) return null;
    const scored = toScoredResults(envResults, testMap);
    return computeMetrics(scored.results, { unknownTestIds: scored.unknownTestIds.length });
  };

  const confirmedAttackSuccesses = allScored.results.filter(
    (s) => s.label === "attack" && s.verdict === "fail",
  ).length;

  const categoryBreakdown = CATEGORIES.map((category) => {
    const inCat = allResults.filter((r) => getTestCase(r.testId)?.category === category);
    return {
      category,
      failed: inCat.filter((r) => r.verdict === "fail").length,
      total: inCat.length,
    };
  }).filter((c) => c.total > 0);

  return {
    totalRuns: runs.length,
    totalTests: allResults.length,
    confirmedAttackSuccesses,
    attackSuccessRate: overall.attackSuccessRate,
    defenseBlockRate: overall.defenseBlockRate,
    benignFalseRefusalRate: overall.benignFalseRefusalRate,
    medianLatencyMs: overall.medianLatencyMs,
    inconclusive: overall.inconclusive,
    errors: overall.errors,
    openFindings: findings.filter((f) => f.status === "open").length,
    byEnvironment: {
      baseline: envMetrics("baseline"),
      defended: envMetrics("defended"),
    },
    categoryBreakdown,
    recentRuns: runs.slice(0, 8).map((r) => ({
      id: r.id,
      environment: r.environment,
      suite: r.suite,
      at: r.startedAt,
      passed: r.results.filter((x) => x.verdict === "pass").length,
      failed: r.results.filter((x) => x.verdict === "fail").length,
      total: r.results.length,
    })),
    topFindings: findings.filter((f) => f.status !== "resolved").slice(0, 5),
  };
}
