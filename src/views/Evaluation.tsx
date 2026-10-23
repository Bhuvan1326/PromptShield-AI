import { useEffect, useMemo, useState } from "react";
import { ClipboardCopy, FileJson } from "lucide-react";
import type { RunRecord } from "@shared/types";
import { api, type RunSummary } from "../lib/api";
import { fmtTime, pct, pctExact } from "../lib/format";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  EmptyState,
  EnvBadge,
  ErrorBanner,
  SectionTitle,
  Spinner,
  StatCard,
  VerdictBadge,
} from "../components/ui";

const DEFINITIONS: { key: string; name: string; def: string }[] = [
  { key: "attackSuccessRate", name: "Attack success rate", def: "Attack cases scored fail ÷ all scored attack cases. Lower is better." },
  { key: "defenseBlockRate", name: "Defense block rate", def: "Attack cases scored pass ÷ all scored attack cases." },
  { key: "benignFalseRefusalRate", name: "Benign false refusal rate", def: "Benign cases wrongly blocked ÷ all scored benign cases. Lower is better." },
  { key: "precision", name: "Precision", def: "TP ÷ (TP + FP) — of all refusals, how many were real attacks." },
  { key: "recall", name: "Recall", def: "TP ÷ (TP + FN) — of all real attacks, how many were neutralized." },
  { key: "f1", name: "F1 score", def: "Harmonic mean of precision and recall." },
];

export default function Evaluation({ ctx }: { ctx: AppContext }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .listRuns()
      .then((r) => {
        setRuns(r);
        if (r.length && !selectedId) setSelectedId(r[0].id);
      })
      .catch((e) => setError(e.message));
  }, [ctx.refreshSignal]);

  useEffect(() => {
    if (!selectedId) return;
    api.getRun(selectedId).then(setRun).catch((e) => setError(e.message));
  }, [selectedId]);

  const testById = useMemo(
    () => new Map(ctx.catalog.testCases.map((t) => [t.id, t])),
    [ctx.catalog],
  );

  async function exportReport() {
    if (!run) return;
    const report = await api.getReport(run.id);
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `promptshield-report-${run.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copySummary() {
    if (!run) return;
    const m = run.metrics;
    const summary = [
      `PromptShield AI — Executive Summary (simulated harness)`,
      `Run ${run.id} · environment: ${run.environment} · suite: ${run.suite} · ${run.startedAt}`,
      `${m.total} tests executed: ${m.scoredAttack} attack, ${m.scoredBenign} benign, ${m.invalid} robustness, ${m.inconclusive} inconclusive, ${m.errors} errors.`,
      `Attack success rate: ${pct(m.attackSuccessRate)} · Defense block rate: ${pct(m.defenseBlockRate)} · Benign false refusal rate: ${pct(m.benignFalseRefusalRate)}.`,
      `Precision ${pct(m.precision)} · Recall ${pct(m.recall)} · F1 ${m.f1 === null ? "n/a" : m.f1}.`,
      `Confusion matrix: TP=${m.confusion.tp} FP=${m.confusion.fp} TN=${m.confusion.tn} FN=${m.confusion.fn}.`,
      `Scope: deterministic simulation with synthetic data only — not a live-LLM measurement.`,
    ].join("\n");
    await navigator.clipboard.writeText(summary);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (error) return <ErrorBanner message={error} />;
  if (!runs) return <Spinner label="Loading runs…" />;
  if (runs.length === 0)
    return (
      <EmptyState
        title="No runs to evaluate"
        hint="Execute tests in the Test Lab — metrics are computed from actual results and appear here."
      />
    );

  const m = run?.metrics;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-bold">Evaluation</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          Metrics computed from real test executions in this session — never hardcoded.
          These are simulated-harness metrics: they measure the deterministic engine's
          behavior, not live LLM performance.
        </p>
      </header>

      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-muted">Run</label>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="max-w-md flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs text-foreground focus:border-accent/50 focus:outline-none"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {fmtTime(r.startedAt)} · {r.environment} · {r.suite} · {r.resultCount} tests
              </option>
            ))}
          </select>
          {run && (
            <>
              <EnvBadge environment={run.environment} />
              <Button variant="ghost" onClick={exportReport}>
                <FileJson size={12} /> Export JSON report
              </Button>
              <Button variant="ghost" onClick={copySummary}>
                <ClipboardCopy size={12} /> {copied ? "Copied!" : "Copy executive summary"}
              </Button>
            </>
          )}
        </div>
      </Card>

      {!run || !m ? (
        <Spinner label="Loading run…" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Attack success" value={pct(m.attackSuccessRate)} tone="danger" hint={`${m.scoredAttack} scored attacks`} />
            <StatCard label="Block rate" value={pct(m.defenseBlockRate)} tone="success" />
            <StatCard label="False refusals" value={pct(m.benignFalseRefusalRate)} tone="warning" hint={`${m.scoredBenign} scored benign`} />
            <StatCard label="Precision" value={pctExact(m.precision)} />
            <StatCard label="Recall" value={pctExact(m.recall)} />
            <StatCard label="F1" value={m.f1 === null ? "n/a" : m.f1.toFixed(3)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <SectionTitle
                title="Confusion matrix"
                subtitle="Positive class = attack · inconclusive, error and robustness cases excluded"
              />
              <div className="mx-auto grid max-w-sm grid-cols-3 gap-1 text-center text-xs">
                <div />
                <div className="pb-1 text-[10px] uppercase tracking-wider text-muted">Predicted attack</div>
                <div className="pb-1 text-[10px] uppercase tracking-wider text-muted">Predicted benign</div>
                <div className="flex items-center justify-end pr-2 text-[10px] uppercase tracking-wider text-muted">
                  Actual attack
                </div>
                <div className="rounded-md border border-success/40 bg-success/10 p-3">
                  <div className="text-xl font-semibold text-success">{m.confusion.tp}</div>
                  <div className="text-[10px] text-muted">TP · neutralized</div>
                </div>
                <div className="rounded-md border border-danger/40 bg-danger/10 p-3">
                  <div className="text-xl font-semibold text-danger">{m.confusion.fn}</div>
                  <div className="text-[10px] text-muted">FN · attack succeeded</div>
                </div>
                <div className="flex items-center justify-end pr-2 text-[10px] uppercase tracking-wider text-muted">
                  Actual benign
                </div>
                <div className="rounded-md border border-danger/40 bg-danger/10 p-3">
                  <div className="text-xl font-semibold text-danger">{m.confusion.fp}</div>
                  <div className="text-[10px] text-muted">FP · false refusal</div>
                </div>
                <div className="rounded-md border border-success/40 bg-success/10 p-3">
                  <div className="text-xl font-semibold text-success">{m.confusion.tn}</div>
                  <div className="text-[10px] text-muted">TN · answered</div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px] text-muted">
                <div className="rounded border border-border bg-surface/60 py-1.5">
                  {m.invalid} robustness (excluded)
                </div>
                <div className="rounded border border-border bg-surface/60 py-1.5">
                  {m.inconclusive} inconclusive (excluded)
                </div>
                <div className="rounded border border-border bg-surface/60 py-1.5">
                  {m.errors} errors (excluded)
                </div>
              </div>
            </Card>

            <Card>
              <SectionTitle title="Metric definitions & denominators" />
              <dl className="space-y-2.5">
                {DEFINITIONS.map((d) => (
                  <div key={d.key} className="flex gap-3">
                    <dt className="w-40 shrink-0 text-xs font-medium text-foreground">{d.name}</dt>
                    <dd className="text-[11px] leading-relaxed text-muted">{d.def}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 rounded-md border border-border bg-surface/60 px-3 py-2 text-[10px] leading-relaxed text-muted">
                n/a is shown whenever a denominator is zero. Robustness ('invalid') cases are
                scored pass/fail but excluded from the confusion matrix — they measure input
                handling, not attack detection.
              </p>
            </Card>
          </div>

          <Card>
            <SectionTitle title="Per-test outcomes" subtitle={`${m.total} executions in this run`} />
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted">
                  <th className="pb-2">Test</th>
                  <th className="pb-2">Label</th>
                  <th className="pb-2">Category</th>
                  <th className="pb-2">Verdict</th>
                  <th className="pb-2">Latency</th>
                  <th className="pb-2">Observations</th>
                </tr>
              </thead>
              <tbody>
                {run.results.map((r) => {
                  const t = testById.get(r.testId);
                  const obs = [
                    r.canaryLeaked && "canary leaked",
                    r.privateDataLeaked && "private data leaked",
                    r.actionExecuted && "action executed",
                    r.blocked && "blocked",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return (
                    <tr key={r.testId} className="border-b border-border/50 last:border-0">
                      <td className="py-2 font-mono text-[10px] text-muted">{r.testId}</td>
                      <td className="py-2 text-muted">{t?.label}</td>
                      <td className="py-2 text-muted">{t?.category.replace(/_/g, " ")}</td>
                      <td className="py-2">
                        <VerdictBadge verdict={r.verdict} />
                      </td>
                      <td className="py-2 tabular-nums text-muted">{r.durationMs}ms</td>
                      <td className="py-2 text-[11px] text-muted">{obs || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}
