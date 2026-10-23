import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { api, type DefenseCompare, type RunSummary } from "../lib/api";
import { fmtTime, pct } from "../lib/format";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  EmptyState,
  ErrorBanner,
  SectionTitle,
  Spinner,
  VerdictBadge,
} from "../components/ui";

/**
 * Defense Effectiveness Lab — compare any two runs (baseline vs defended,
 * or same-env run regression analysis). Missing results are reported, never
 * counted as blocked.
 */
export default function DefenseLab({ ctx: _ctx }: { ctx: AppContext }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [cmp, setCmp] = useState<DefenseCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.listRuns().then((rs) => {
      setRuns(rs);
      const baseline = rs.find((r) => r.environment === "baseline");
      const defended = rs.find((r) => r.environment === "defended");
      setA(baseline?.id ?? rs[0]?.id ?? "");
      setB(defended?.id ?? rs[0]?.id ?? "");
    }).catch((e) => setError(e.message));
  }, []);

  async function compare() {
    if (!a || !b) return;
    setBusy(true);
    setError(null);
    try {
      setCmp(await api.defenseCompare(a, b));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Comparison failed");
      setCmp(null);
    } finally {
      setBusy(false);
    }
  }

  if (error && !runs) return <ErrorBanner message={error} />;
  if (!runs) return <Spinner label="Loading runs…" />;
  if (runs.length === 0)
    return <EmptyState title="No runs to compare" hint="Execute tests in the Test Lab or run an agent session first." />;

  const sel = (id: string) => runs.find((r) => r.id === id);

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-base font-semibold">Defense Effectiveness Lab</h1>
        <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
          Compare any two executions — baseline vs defended, or a defense version against
          its previous results. Regressions = tests that pass in A and fail in B.
        </p>
      </header>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-2xs text-muted">
            Reference (A)
            <select aria-label="Reference run" value={a} onChange={(e) => setA(e.target.value)} className="max-w-56 rounded-md border border-border bg-card px-2 py-1 font-mono text-2xs">
              {runs.map((r) => <option key={r.id} value={r.id}>{r.environment} · {fmtTime(r.startedAt)} · {r.resultCount}t</option>)}
            </select>
          </label>
          <ArrowRight size={14} className="text-muted" />
          <label className="flex items-center gap-2 text-2xs text-muted">
            Candidate (B)
            <select aria-label="Candidate run" value={b} onChange={(e) => setB(e.target.value)} className="max-w-56 rounded-md border border-border bg-card px-2 py-1 font-mono text-2xs">
              {runs.map((r) => <option key={r.id} value={r.id}>{r.environment} · {fmtTime(r.startedAt)} · {r.resultCount}t</option>)}
            </select>
          </label>
          <Button onClick={compare} disabled={busy || !a || !b}>
            {busy ? <Spinner /> : "Compare"}
          </Button>
        </div>
      </Card>
      {error && <ErrorBanner message={error} />}

      {cmp && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <MetricDelta label="Attack success" a={cmp.a.metrics.attackSuccessRate} b={cmp.b.metrics.attackSuccessRate} invert />
            <MetricDelta label="Block rate" a={cmp.a.metrics.defenseBlockRate} b={cmp.b.metrics.defenseBlockRate} />
            <MetricDelta label="False refusals" a={cmp.a.metrics.benignFalseRefusalRate} b={cmp.b.metrics.benignFalseRefusalRate} invert />
            <Card className="p-3">
              <div className="text-2xs uppercase tracking-wider text-muted">Regressions</div>
              <div className="mt-1 flex items-center gap-2 text-lg font-semibold tabular-nums">
                {cmp.regressions > 0 && <AlertTriangle size={15} className="text-danger" />}
                <span className={cmp.regressions > 0 ? "text-danger" : "text-success"}>{cmp.regressions}</span>
              </div>
              <div className="text-2xs text-muted">{cmp.missingInB} missing in B (reported, not scored)</div>
            </Card>
          </div>

          <Card className="overflow-hidden">
            <SectionTitle
              title={`${sel(a)?.environment ?? "?"} → ${sel(b)?.environment ?? "?"}`}
              subtitle={cmp.note}
            />
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted">
                  <th scope="col" className="px-4 py-2 font-medium">Test</th>
                  <th scope="col" className="px-4 py-2 font-medium">Category</th>
                  <th scope="col" className="px-4 py-2 font-medium">A verdict</th>
                  <th scope="col" className="px-4 py-2 font-medium">B verdict</th>
                  <th scope="col" className="px-4 py-2 font-medium">Flags</th>
                  <th scope="col" className="px-4 py-2 font-medium">Δ latency</th>
                </tr>
              </thead>
              <tbody>
                {cmp.rows.map((r) => (
                  <tr key={r.testId} className={r.regression ? "border-b border-danger/30 bg-danger/5" : "border-b border-border/50"}>
                    <td className="px-4 py-1.5 font-mono">{r.testId}</td>
                    <td className="px-4 py-1.5 text-muted">{r.category}</td>
                    <td className="px-4 py-1.5"><VerdictBadge verdict={r.a.verdict} /></td>
                    <td className="px-4 py-1.5">{r.b ? <VerdictBadge verdict={r.b.verdict} /> : <span className="text-2xs text-muted">missing</span>}</td>
                    <td className="px-4 py-1.5 text-2xs">
                      {r.regression && <span className="mr-1 rounded bg-danger/10 px-1.5 py-0.5 text-danger">regression</span>}
                      {r.b?.canaryLeaked && <span className="mr-1 rounded bg-danger/10 px-1.5 py-0.5 text-danger">canary</span>}
                      {r.b?.actionExecuted && <span className="mr-1 rounded bg-warning/10 px-1.5 py-0.5 text-warning">action</span>}
                      {r.b?.blocked && <span className="rounded bg-success/10 px-1.5 py-0.5 text-success">blocked</span>}
                    </td>
                    <td className="px-4 py-1.5 font-mono text-2xs text-muted">
                      {r.latencyDeltaMs === null ? "—" : `${r.latencyDeltaMs >= 0 ? "+" : ""}${r.latencyDeltaMs}ms`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      <p className="px-1 text-2xs leading-relaxed text-muted">
        ASR = verified successful attacks ÷ eligible completed attack attempts (see Evaluation
        for exact denominators). Both runs are deterministic simulations — comparisons
        describe the engine's two configurations, not live models.
      </p>
    </div>
  );
}

function MetricDelta({ label, a, b, invert }: { label: string; a: number | null; b: number | null; invert?: boolean }) {
  const delta = a !== null && b !== null ? b - a : null;
  const good = delta === null ? null : invert ? delta < 0 : delta > 0;
  return (
    <Card className="p-3">
      <div className="text-2xs uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-1 font-mono text-sm">
        {pct(a)} <span className="text-muted">→</span> {pct(b)}
      </div>
      <div className={`text-2xs ${good === null ? "text-muted" : good ? "text-success" : "text-danger"}`}>
        {delta === null ? "n/a" : `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts`}
      </div>
    </Card>
  );
}
