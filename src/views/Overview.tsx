import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { OverviewStats } from "@shared/types";
import { api } from "../lib/api";
import { pct, fmtMs, fmtTime } from "../lib/format";
import type { AppContext } from "../App";
import {
  Card,
  EmptyState,
  EnvBadge,
  SectionTitle,
  SeverityBadge,
  Spinner,
  StatCard,
} from "../components/ui";

export default function Overview({ ctx }: { ctx: AppContext }) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.overview().then(setStats).catch((e) => setError(e.message));
  }, [ctx.refreshSignal]);

  if (error)
    return <div className="text-xs text-danger">Failed to load overview: {error}</div>;
  if (!stats) return <Spinner label="Loading overview…" />;

  const empty = stats.totalRuns === 0;
  const catLabel: Record<string, string> = {
    benign: "Benign",
    prompt_injection: "Prompt injection",
    indirect_injection: "Indirect injection",
    data_extraction: "Data extraction",
    unauthorized_action: "Unauthorized action",
    robustness: "Robustness",
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-bold">Security Posture Overview</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          Deterministic simulation harness comparing an intentionally vulnerable baseline
          assistant against a guarded configuration — synthetic data only. Metrics below
          are computed from actual executed tests, never from canned numbers.
        </p>
      </header>

      {empty ? (
        <EmptyState
          title="No test runs yet"
          hint="Head to the Test Lab and run the full suite against both environments to populate this dashboard."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Total runs" value={String(stats.totalRuns)} hint={`${stats.totalTests} test executions`} />
            <StatCard
              label="Attack success rate"
              value={pct(stats.attackSuccessRate)}
              hint={`${stats.confirmedAttackSuccesses} confirmed attack success(es)`}
              tone="danger"
            />
            <StatCard
              label="Defense block rate"
              value={pct(stats.defenseBlockRate)}
              hint="attacks neutralized ÷ scored attacks"
              tone="success"
            />
            <StatCard
              label="Benign false refusals"
              value={pct(stats.benignFalseRefusalRate)}
              hint="harmless requests wrongly blocked"
              tone="warning"
            />
            <StatCard label="Median latency" value={fmtMs(stats.medianLatencyMs)} />
            <StatCard
              label="Open findings"
              value={String(stats.openFindings)}
              hint={`${stats.inconclusive} inconclusive · ${stats.errors} errors`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionTitle
                title="Environment comparison"
                subtitle="Same suite, different guardrails — aggregated across all runs"
              />
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted">
                    <th className="pb-2">Environment</th>
                    <th className="pb-2">Attack success</th>
                    <th className="pb-2">Block rate</th>
                    <th className="pb-2">False refusals</th>
                    <th className="pb-2">F1</th>
                  </tr>
                </thead>
                <tbody>
                  {(["baseline", "defended"] as const).map((env) => {
                    const m = stats.byEnvironment[env];
                    return (
                      <tr key={env} className="border-b border-border/50 last:border-0">
                        <td className="py-2.5">
                          <EnvBadge environment={env} />
                        </td>
                        <td className="py-2.5 tabular-nums text-danger">{m ? pct(m.attackSuccessRate) : "—"}</td>
                        <td className="py-2.5 tabular-nums text-success">{m ? pct(m.defenseBlockRate) : "—"}</td>
                        <td className="py-2.5 tabular-nums text-warning">{m ? pct(m.benignFalseRefusalRate) : "—"}</td>
                        <td className="py-2.5 tabular-nums">{m?.f1 !== null && m ? m.f1.toFixed(2) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-3 text-[10px] leading-snug text-muted">
                The baseline is intentionally vulnerable so the contrast is demonstrable.
                Neither simulator is a real LLM.
              </p>
            </Card>

            <Card>
              <SectionTitle
                title="Failures by category"
                subtitle="Failed executions ÷ total executions per category, all runs"
              />
              {stats.categoryBreakdown.length === 0 ? (
                <EmptyState title="No executions yet" />
              ) : (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart
                    data={stats.categoryBreakdown.map((c) => ({
                      name: catLabel[c.category] ?? c.category,
                      failed: c.failed,
                      passed: c.total - c.failed,
                    }))}
                    layout="vertical"
                    margin={{ left: 40, right: 12 }}
                  >
                    <CartesianGrid stroke="#263650" strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" allowDecimals={false} stroke="#91A4C3" fontSize={10} />
                    <YAxis type="category" dataKey="name" width={110} stroke="#91A4C3" fontSize={10} />
                    <Tooltip
                      contentStyle={{ background: "#162238", border: "1px solid #263650", fontSize: 11 }}
                      cursor={{ fill: "rgba(34,211,238,0.05)" }}
                    />
                    <Bar dataKey="failed" stackId="a" fill="#FB7185" name="Failed" />
                    <Bar dataKey="passed" stackId="a" fill="#34D399" name="Passed/inconclusive" radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionTitle title="Recent runs" />
              {stats.recentRuns.length === 0 ? (
                <EmptyState title="No runs recorded" />
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted">
                      <th className="pb-2">Run</th>
                      <th className="pb-2">Env</th>
                      <th className="pb-2">Suite</th>
                      <th className="pb-2">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentRuns.map((r) => (
                      <tr key={r.id} className="border-b border-border/50 last:border-0">
                        <td className="py-2 font-mono text-[11px] text-muted">{fmtTime(r.at)}</td>
                        <td className="py-2">
                          <EnvBadge environment={r.environment} />
                        </td>
                        <td className="py-2 text-muted">{r.suite}</td>
                        <td className="py-2 tabular-nums">
                          <span className="text-success">{r.passed}✓</span>{" "}
                          <span className="text-danger">{r.failed}✗</span>{" "}
                          <span className="text-muted">/ {r.total}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>

            <Card>
              <SectionTitle
                title="Top open findings"
                subtitle="Newest unresolved findings across runs"
                right={
                  <Link to="/findings" className="text-xs text-accent hover:underline">
                    View all →
                  </Link>
                }
              />
              {stats.topFindings.length === 0 ? (
                <EmptyState title="No open findings" hint="Run the suite on the baseline to see vulnerabilities surface." />
              ) : (
                <ul className="space-y-2">
                  {stats.topFindings.map((f) => (
                    <li
                      key={f.id}
                      className="flex items-start justify-between gap-3 rounded-md border border-border bg-surface/60 px-3 py-2"
                    >
                      <div>
                        <p className="text-xs font-medium">{f.title}</p>
                        <p className="mt-0.5 font-mono text-[10px] text-muted">
                          {f.testId} · <EnvBadge environment={f.environment} />
                        </p>
                      </div>
                      <SeverityBadge severity={f.severity} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
