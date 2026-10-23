import { useEffect, useMemo, useState } from "react";
import { ClipboardCopy, FileJson, Sparkles } from "lucide-react";
import type { AiRunAnalysis, RunRecord } from "@shared/types";
import { api, type RunSummary } from "../lib/api";
import { fmtTime, pct, pctExact } from "../lib/format";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  EmptyState,
  EnvBadge,
  ErrorBanner,
  MetricBlock,
  SectionTitle,
  Spinner,
  Tag,
  VerdictBadge,
} from "../components/ui";

const DEFINITIONS: { key: string; name: string; def: string }[] = [
  { key: "attackSuccessRate", name: "Attack success rate", def: "attack cases scored fail ÷ scored attack cases — lower is better" },
  { key: "defenseBlockRate", name: "Defense block rate", def: "attack cases scored pass ÷ scored attack cases" },
  { key: "benignFalseRefusalRate", name: "Benign false refusal", def: "benign cases wrongly blocked ÷ scored benign cases — lower is better" },
  { key: "precision", name: "Precision", def: "TP ÷ (TP + FP) — of all refusals, how many were real attacks" },
  { key: "recall", name: "Recall", def: "TP ÷ (TP + FN) — of all real attacks, how many were neutralized" },
  { key: "f1", name: "F1 score", def: "harmonic mean of precision and recall" },
];

export default function Evaluation({ ctx }: { ctx: AppContext }) {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [analysis, setAnalysis] = useState<AiRunAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listRuns()
      .then((r) => {
        setRuns(r);
        setSelectedId((cur) => cur || r[0]?.id || "");
      })
      .catch((e) => setError(e.message));
  }, [ctx.refreshSignal]);

  useEffect(() => {
    if (!selectedId) return;
    setAnalysis(null);
    setAnalysisError(null);
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

  async function analyze() {
    if (!run) return;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      setAnalysis(await api.analyzeRun(run.id));
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : "AI analysis failed");
    } finally {
      setAnalyzing(false);
    }
  }

  if (error) return <ErrorBanner message={error} />;
  if (!runs) return <Spinner label="Loading runs…" />;
  if (runs.length === 0)
    return (
      <div className="space-y-4">
        <header>
          <h1 className="text-base font-semibold">Evaluation</h1>
        </header>
        <EmptyState
          title="No runs to evaluate"
          hint="Execute tests in the Test Lab — metrics are computed from actual results and appear here."
        />
      </div>
    );

  const m = run?.metrics;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-base font-semibold">Evaluation</h1>
        <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
          Metrics computed from real executions — never hardcoded.{" "}
          <Tag>simulated harness metrics</Tag>{" "}
          <span className="text-muted/80">These measure the deterministic engine, not live LLM performance.</span>
        </p>
      </header>

      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-3">
          <label
            htmlFor="run-select"
            className="text-2xs font-medium uppercase tracking-wider text-muted"
          >
            Run
          </label>
          <select
            id="run-select"
            aria-label="Select run to evaluate"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="max-w-md flex-1 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-2xs text-foreground focus:border-accent/50 focus:outline-none"
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
                <FileJson size={11} /> Export JSON
              </Button>
              <Button variant="ghost" onClick={copySummary}>
                <ClipboardCopy size={11} /> {copied ? "Copied" : "Copy summary"}
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
            <MetricBlock label="Attack success" value={pct(m.attackSuccessRate)} tone="danger" hint={`${m.scoredAttack} scored attacks`} />
            <MetricBlock label="Block rate" value={pct(m.defenseBlockRate)} tone="success" hint={`${m.scoredAttack} scored attacks`} />
            <MetricBlock label="False refusals" value={pct(m.benignFalseRefusalRate)} tone="warning" hint={`${m.scoredBenign} scored benign`} />
            <MetricBlock label="Precision" value={pctExact(m.precision)} hint={`TP ${m.confusion.tp} · FP ${m.confusion.fp}`} />
            <MetricBlock label="Recall" value={pctExact(m.recall)} hint={`TP ${m.confusion.tp} · FN ${m.confusion.fn}`} />
            <MetricBlock label="F1" value={m.f1 === null ? "n/a" : m.f1.toFixed(3)} />
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <SectionTitle
                title="Confusion matrix"
                subtitle="Positive class = attack · inconclusive, error and robustness cases excluded"
              />
              <div className="p-4">
                <div className="mx-auto grid max-w-sm grid-cols-3 gap-1 text-center text-xs">
                  <div />
                  <div className="pb-1 text-2xs uppercase tracking-wider text-muted">Pred. attack</div>
                  <div className="pb-1 text-2xs uppercase tracking-wider text-muted">Pred. benign</div>
                  <div className="flex items-center justify-end pr-2 text-2xs uppercase tracking-wider text-muted">
                    Actual attack
                  </div>
                  <div className="rounded-md border border-success/40 bg-success/5 p-3">
                    <div className="text-lg font-semibold tabular-nums text-success">{m.confusion.tp}</div>
                    <div className="text-2xs text-muted">TP · neutralized</div>
                  </div>
                  <div className="rounded-md border border-danger/40 bg-danger/5 p-3">
                    <div className="text-lg font-semibold tabular-nums text-danger">{m.confusion.fn}</div>
                    <div className="text-2xs text-muted">FN · attack succeeded</div>
                  </div>
                  <div className="flex items-center justify-end pr-2 text-2xs uppercase tracking-wider text-muted">
                    Actual benign
                  </div>
                  <div className="rounded-md border border-danger/40 bg-danger/5 p-3">
                    <div className="text-lg font-semibold tabular-nums text-danger">{m.confusion.fp}</div>
                    <div className="text-2xs text-muted">FP · false refusal</div>
                  </div>
                  <div className="rounded-md border border-success/40 bg-success/5 p-3">
                    <div className="text-lg font-semibold tabular-nums text-success">{m.confusion.tn}</div>
                    <div className="text-2xs text-muted">TN · answered</div>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 text-center text-2xs text-muted sm:grid-cols-4">
                  <div className="rounded border border-border bg-card py-1.5">
                    {m.invalid} robustness · excluded
                  </div>
                  <div className="rounded border border-border bg-card py-1.5">
                    {m.inconclusive} inconclusive · excluded
                  </div>
                  <div className="rounded border border-border bg-card py-1.5">
                    {m.errors} errors · excluded
                  </div>
                  <div className="rounded border border-border bg-card py-1.5">
                    {m.unknownTestIds} unknown IDs · excluded
                  </div>
                </div>
              </div>
            </Card>

            <Card>
              <SectionTitle title="Metric definitions" subtitle="Denominators and exclusion rules" />
              <dl className="space-y-3 p-4">
                {DEFINITIONS.map((d) => (
                  <div key={d.key} className="flex gap-4">
                    <dt className="w-36 shrink-0 text-xs font-medium text-foreground">{d.name}</dt>
                    <dd className="font-mono text-2xs leading-relaxed text-muted">{d.def}</dd>
                  </div>
                ))}
              </dl>
              <p className="mx-4 mb-4 rounded-md border border-border bg-card px-3 py-2 text-2xs leading-relaxed text-muted">
                n/a is shown whenever a denominator is zero. Robustness ('invalid') cases are
                scored pass/fail but excluded from the confusion matrix — they measure input
                handling, not attack detection.
              </p>
            </Card>
          </div>

          <Card>
            <SectionTitle
              title="AI-assisted analysis"
              subtitle="Advisory model output — deterministic metrics above remain authoritative"
              right={
                <Button
                  variant="ghost"
                  onClick={analyze}
                  disabled={analyzing || !run || ctx.status?.gemini.state !== "configured"}
                >
                  <Sparkles size={11} /> {analyzing ? "Analyzing…" : "Run AI analysis"}
                </Button>
              }
            />
            <div className="p-4 text-xs">
              {ctx.status?.gemini.state !== "configured" ? (
                <p className="text-muted">
                  AI analysis unavailable — Gemini is not configured. The deterministic
                  evaluation above is complete without it.
                </p>
              ) : analysisError ? (
                <ErrorBanner message={analysisError} />
              ) : !analysis ? (
                <p className="text-muted">
                  Reviews this run's intent, verdict consistency and mitigations using
                  sanitized evidence. Output is schema-validated and labeled AI-generated.
                </p>
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag>AI-generated</Tag>
                    <span
                      className={
                        "rounded px-1.5 py-0.5 text-2xs font-medium " +
                        (analysis.assessment === "agree"
                          ? "bg-success/10 text-success"
                          : analysis.assessment === "disagree"
                            ? "bg-danger/10 text-danger"
                            : "bg-warning/10 text-warning")
                      }
                    >
                      verdict consistency: {analysis.assessment}
                    </span>
                    <span className="font-mono text-2xs text-muted">
                      {analysis.model} · {fmtTime(analysis.generatedAt)}
                    </span>
                  </div>
                  <p className="text-2xs italic leading-relaxed text-muted">{analysis.methodology}</p>
                  <div>
                    <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted">Attack intent</div>
                    <p className="leading-relaxed text-foreground">{analysis.attackIntent}</p>
                  </div>
                  <div>
                    <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted">Evidence summary</div>
                    <p className="leading-relaxed text-foreground">{analysis.evidenceSummary}</p>
                  </div>
                  <div>
                    <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted">Reasoning</div>
                    <p className="leading-relaxed text-foreground">{analysis.reasoning}</p>
                  </div>
                  {analysis.suggestedTests.length > 0 && (
                    <div>
                      <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted">
                        Suggested adversarial inputs (model-generated, not scored)
                      </div>
                      <ul className="space-y-1.5">
                        {analysis.suggestedTests.map((t, i) => (
                          <li key={i} className="rounded border border-border bg-card p-2">
                            <div className="font-medium">{t.title}</div>
                            <div className="mt-0.5 font-mono text-2xs text-muted">{t.input}</div>
                            <div className="mt-0.5 text-2xs text-muted">{t.rationale}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {analysis.mitigations.length > 0 && (
                    <div>
                      <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted">Mitigations</div>
                      <ul className="list-disc space-y-0.5 pl-4 leading-relaxed">
                        {analysis.mitigations.map((m2, i) => (
                          <li key={i}>{m2}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          <Card className="overflow-hidden">
            <SectionTitle title="Per-test outcomes" subtitle={`${m.total} executions in this run`} />
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted">
                  <th className="px-4 py-2 font-medium">Test</th>
                  <th className="px-4 py-2 font-medium">Label</th>
                  <th className="px-4 py-2 font-medium">Category</th>
                  <th className="px-4 py-2 font-medium">Verdict</th>
                  <th className="px-4 py-2 font-medium">Latency</th>
                  <th className="px-4 py-2 font-medium">Observations</th>
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
                    <tr key={r.testId} className="border-b border-border/50 last:border-0 hover:bg-card/40">
                      <td className="px-4 py-2 font-mono text-2xs text-muted">{r.testId}</td>
                      <td className="px-4 py-2 text-muted">{t?.label}</td>
                      <td className="px-4 py-2 text-2xs text-muted">{t?.category.replace(/_/g, " ")}</td>
                      <td className="px-4 py-2">
                        <VerdictBadge verdict={r.verdict} />
                      </td>
                      <td className="px-4 py-2 font-mono text-2xs tabular-nums text-muted">
                        {r.durationMs}ms
                      </td>
                      <td className="px-4 py-2 text-2xs text-muted">{obs || "—"}</td>
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
