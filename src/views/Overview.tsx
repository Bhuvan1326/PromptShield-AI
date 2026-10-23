import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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
  Button,
  Card,
  EmptyState,
  EnvBadge,
  MetricBlock,
  SectionTitle,
  SeverityBadge,
  Spinner,
  StatusBadge,
  Tag,
} from "../components/ui";

const CATEGORY_LABEL: Record<string, string> = {
  benign: "Benign",
  prompt_injection: "Prompt injection",
  indirect_injection: "Indirect injection",
  data_extraction: "Data extraction",
  unauthorized_action: "Unauthorized action",
  robustness: "Robustness",
};

export default function Overview({ ctx }: { ctx: AppContext }) {
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);

  useEffect(() => {
    api.overview().then(setStats).catch((e) => setError(e.message));
  }, [ctx.refreshSignal]);

  async function runFullSuite() {
    setBootstrapping(true);
    try {
      await api.runSuite(ctx.environment, "full");
      ctx.triggerRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setBootstrapping(false);
    }
  }

  if (error)
    return <div className="text-xs text-danger">Failed to load overview: {error}</div>;
  if (!stats) return <Spinner label="Loading overview…" />;

  const empty = stats.totalRuns === 0;
  const hasEnvData = stats.byEnvironment.baseline !== null || stats.byEnvironment.defended !== null;

  const envChartData = (["baseline", "defended"] as const)
    .filter((env) => stats.byEnvironment[env] !== null)
    .map((env) => {
      const m = stats.byEnvironment[env]!;
      return {
        name: env,
        "Attack success": m.attackSuccessRate === null ? 0 : Math.round(m.attackSuccessRate * 100),
        "Block rate": m.defenseBlockRate === null ? 0 : Math.round(m.defenseBlockRate * 100),
        "False refusals": m.benignFalseRefusalRate === null ? 0 : Math.round(m.benignFalseRefusalRate * 100),
      };
    });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Security posture</h1>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            Aggregated from actual test executions in this workspace.{" "}
            <Tag>simulated harness metrics</Tag>
          </p>
        </div>
        <Button onClick={runFullSuite} disabled={bootstrapping}>
          {bootstrapping ? <Spinner /> : <><Play size={11} /> Run full suite on {ctx.environment}</>}
        </Button>
      </header>

      {empty ? (
        <EmptyState
          title="No test executions yet"
          hint="Run the curated suite to populate attack success, block rate, false-refusal and latency metrics — all computed from real runs."
          action={
            <Button onClick={runFullSuite} disabled={bootstrapping}>
              {bootstrapping ? <Spinner /> : <><Play size={11} /> Run Test Suite</>}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <MetricBlock
              label="Tests executed"
              value={String(stats.totalTests)}
              hint={`${stats.totalRuns} run(s) · ${stats.inconclusive} inconclusive · ${stats.errors} errors`}
            />
            <MetricBlock
              label="Confirmed attack successes"
              value={String(stats.confirmedAttackSuccesses)}
              hint={`attack success rate ${pct(stats.attackSuccessRate)} of scored attacks`}
              tone="danger"
            />
            <MetricBlock
              label="Defense block rate"
              value={pct(stats.defenseBlockRate)}
              hint="attacks neutralized ÷ scored attacks"
              tone="success"
            />
            <MetricBlock
              label="Benign false refusals"
              value={pct(stats.benignFalseRefusalRate)}
              hint="harmless requests blocked ÷ scored benign"
              tone="warning"
            />
            <MetricBlock label="Median latency" value={fmtMs(stats.medianLatencyMs)} hint="per test execution" />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <SectionTitle
                title="Baseline vs defended"
                subtitle="Aggregate rates per environment · percent of scored cases"
              />
              {!hasEnvData ? (
                <div className="p-4">
                  <EmptyState title="No executions yet" />
                </div>
              ) : (
                <div className="p-3">
                  <ResponsiveContainer width="100%" height={190}>
                    <BarChart data={envChartData} margin={{ left: -20, right: 8, top: 4 }}>
                      <CartesianGrid stroke="#2A384B" strokeDasharray="2 4" vertical={false} />
                      <XAxis dataKey="name" stroke="#95A4B8" fontSize={11} tickLine={false} />
                      <YAxis
                        stroke="#95A4B8"
                        fontSize={10}
                        tickLine={false}
                        axisLine={false}
                        unit="%"
                        domain={[0, 100]}
                      />
                      <Tooltip
                        contentStyle={{
                          background: "#182333",
                          border: "1px solid #2A384B",
                          borderRadius: 6,
                          fontSize: 11,
                        }}
                        cursor={{ fill: "rgba(94,234,212,0.04)" }}
                        formatter={(v) => [`${v}%`]}
                      />
                      <Legend wrapperStyle={{ fontSize: 10 }} iconSize={8} />
                      <Bar dataKey="Attack success" fill="#FF7185" radius={[2, 2, 0, 0]} maxBarSize={26} />
                      <Bar dataKey="Block rate" fill="#5EEAD4" radius={[2, 2, 0, 0]} maxBarSize={26} />
                      <Bar dataKey="False refusals" fill="#F6C96B" radius={[2, 2, 0, 0]} maxBarSize={26} />
                    </BarChart>
                  </ResponsiveContainer>
                  {/* Text alternative for the chart */}
                  <table className="sr-only">
                    <caption>Baseline vs defended aggregate rates (percent of scored cases)</caption>
                    <thead>
                      <tr>
                        <th>Environment</th>
                        <th>Attack success %</th>
                        <th>Block rate %</th>
                        <th>False refusals %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {envChartData.map((row) => (
                        <tr key={row.name}>
                          <td>{row.name}</td>
                          <td>{row["Attack success"]}</td>
                          <td>{row["Block rate"]}</td>
                          <td>{row["False refusals"]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="px-1 pb-1 text-2xs leading-snug text-muted">
                    Baseline is intentionally vulnerable so the contrast is demonstrable.
                    Neither simulator is a real LLM.
                  </p>
                </div>
              )}
            </Card>

            <Card>
              <SectionTitle title="Recent runs" subtitle="Newest first" />
              {stats.recentRuns.length === 0 ? (
                <div className="p-4"><EmptyState title="No runs recorded" /></div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted">
                      <th className="px-4 py-2 font-medium">Started</th>
                      <th className="px-4 py-2 font-medium">Env</th>
                      <th className="px-4 py-2 font-medium">Suite</th>
                      <th className="px-4 py-2 font-medium text-right">Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.recentRuns.map((r) => (
                      <tr key={r.id} className="border-b border-border/50 last:border-0 hover:bg-card/40">
                        <td className="px-4 py-2 font-mono text-2xs text-muted">{fmtTime(r.at)}</td>
                        <td className="px-4 py-2"><EnvBadge environment={r.environment} /></td>
                        <td className="px-4 py-2 font-mono text-2xs text-muted">{r.suite}</td>
                        <td className="px-4 py-2 text-right font-mono text-2xs">
                          <span className="text-success">{r.passed} pass</span>
                          <span className="text-muted"> · </span>
                          <span className="text-danger">{r.failed} fail</span>
                          <span className="text-muted"> / {r.total}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </div>

          <Card>
            <SectionTitle
              title="Findings"
              subtitle="Unresolved findings across all runs"
              right={
                <Link to="/findings" className="text-xs text-accent hover:underline">
                  Open findings →
                </Link>
              }
            />
            {stats.topFindings.length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No open findings"
                  hint="Run the suite on the baseline environment to surface vulnerabilities."
                />
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted">
                    <th className="px-4 py-2 font-medium">Severity</th>
                    <th className="px-4 py-2 font-medium">Test</th>
                    <th className="px-4 py-2 font-medium">Finding</th>
                    <th className="px-4 py-2 font-medium">Category</th>
                    <th className="px-4 py-2 font-medium">Mode</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium text-right">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.topFindings.map((f) => (
                    <tr key={f.id} className="border-b border-border/50 last:border-0 hover:bg-card/40">
                      <td className="px-4 py-2"><SeverityBadge severity={f.severity} /></td>
                      <td className="px-4 py-2 font-mono text-2xs text-muted">{f.testId}</td>
                      <td className="px-4 py-2 text-foreground/90">{f.title}</td>
                      <td className="px-4 py-2 text-2xs text-muted">
                        {CATEGORY_LABEL[f.category] ?? f.category}
                      </td>
                      <td className="px-4 py-2"><EnvBadge environment={f.environment} /></td>
                      <td className="px-4 py-2"><StatusBadge status={f.status} /></td>
                      <td className="px-4 py-2 text-right font-mono text-2xs text-muted">
                        {fmtTime(f.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
