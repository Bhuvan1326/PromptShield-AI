import { useEffect, useMemo, useState } from "react";
import { FlaskConical, Play, ShieldAlert, ShieldCheck } from "lucide-react";
import { clsx } from "clsx";
import type { Environment, ExecutionResult, RunRecord, TestCase } from "@shared/types";
import { api } from "../lib/api";
import { fmtMs } from "../lib/format";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  EmptyState,
  EnvBadge,
  ErrorBanner,
  LabelBadge,
  SectionTitle,
  Spinner,
  VerdictBadge,
} from "../components/ui";
import { EvidenceDrawer } from "../components/EvidenceDrawer";

const riskOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

export default function TestLab({ ctx }: { ctx: AppContext }) {
  const [environment, setEnvironment] = useState<Environment>("baseline");
  const [suiteId, setSuiteId] = useState("full");
  const [running, setRunning] = useState<string | null>(null); // suite id or test id
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ExecutionResult | null>(null);

  const testById = useMemo(
    () => new Map(ctx.catalog.testCases.map((t) => [t.id, t])),
    [ctx.catalog],
  );
  const resultById = useMemo(
    () => new Map((run?.results ?? []).map((r) => [r.testId, r])),
    [run],
  );

  async function doRun(fn: () => Promise<RunRecord>, key: string) {
    setRunning(key);
    setError(null);
    try {
      const r = await fn();
      setRun(r);
      ctx.triggerRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(null);
    }
  }

  const envInfo = ctx.catalog.environments[environment];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-lg font-bold">Test Lab</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
          Execute curated, deterministic cases against an isolated simulator. Every verdict
          is scored from the observed response — canary disclosure, action execution and
          refusal behavior — never assumed.
        </p>
      </header>

      {/* Environment selector */}
      <div className="grid gap-3 md:grid-cols-2">
        {(["baseline", "defended"] as const).map((env) => {
          const info = ctx.catalog.environments[env];
          const active = environment === env;
          return (
            <button
              key={env}
              onClick={() => setEnvironment(env)}
              className={clsx(
                "rounded-lg border p-4 text-left transition-colors",
                active
                  ? env === "baseline"
                    ? "border-danger/50 bg-danger/5"
                    : "border-accent/50 bg-accent/5"
                  : "border-border bg-card hover:border-muted/50",
              )}
            >
              <div className="flex items-center gap-2">
                {env === "baseline" ? (
                  <ShieldAlert size={15} className="text-danger" />
                ) : (
                  <ShieldCheck size={15} className="text-accent" />
                )}
                <span className="text-xs font-semibold">{info.name}</span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted">{info.description}</p>
            </button>
          );
        })}
      </div>

      {environment === "baseline" && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[11px] leading-relaxed text-warning">
          Disclosure: the baseline is deliberately vulnerable and only ever handles mock,
          synthetic data inside an isolated deterministic simulator. It cannot touch real
          systems and says nothing about real model behavior.
        </div>
      )}

      {/* Run controls */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-muted">Suite</label>
          <select
            value={suiteId}
            onChange={(e) => setSuiteId(e.target.value)}
            className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground focus:border-accent/50 focus:outline-none"
          >
            {ctx.catalog.suites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.testIds.length} tests
              </option>
            ))}
          </select>
          <Button
            onClick={() => doRun(() => api.runSuite(environment, suiteId), "suite")}
            disabled={running !== null}
          >
            {running === "suite" ? <Spinner label="Running…" /> : <><Play size={12} /> Run suite on {environment}</>}
          </Button>
          <Button
            variant="ghost"
            onClick={() => doRun(() => api.runSuite(environment, "full"), "full")}
            disabled={running !== null}
            title="Run every curated test case"
          >
            <FlaskConical size={12} /> Run Full Suite
          </Button>
          {error && <ErrorBanner message={error} />}
        </div>
      </Card>

      {/* Results + case list */}
      <div className="grid gap-4 xl:grid-cols-5">
        <Card className="xl:col-span-3">
          <SectionTitle
            title="Test cases"
            subtitle="Curated deterministic fixtures — positive (attack) and negative (benign) examples"
          />
          <div className="space-y-2">
            {[...ctx.catalog.testCases]
              .sort((a, b) => riskOrder[a.risk] - riskOrder[b.risk])
              .map((t) => {
                const result = resultById.get(t.id);
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-border bg-surface/50 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[10px] text-muted">{t.id}</span>
                        <LabelBadge label={t.label} />
                        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">
                          {t.category.replace(/_/g, " ")}
                        </span>
                        {result && <VerdictBadge verdict={result.verdict} />}
                      </div>
                      <p className="mt-1 truncate text-xs font-medium">{t.title}</p>
                      <p className="mt-0.5 line-clamp-1 text-[11px] text-muted">{t.description}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {result && (
                        <Button variant="ghost" onClick={() => setSelected(result)}>
                          Evidence
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        disabled={running !== null}
                        onClick={() => doRun(() => api.runTest(environment, t.id), t.id)}
                      >
                        {running === t.id ? <Spinner label="" /> : <><Play size={11} /> Run</>}
                      </Button>
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>

        <Card className="xl:col-span-2">
          <SectionTitle
            title="Latest run"
            subtitle={run ? `${run.suite} · ${run.environment} · ${fmtMs(run.durationMs)}` : "No run in this session yet"}
          />
          {!run ? (
            <EmptyState
              title="Nothing executed yet"
              hint="Run the full suite or a single case to see scored results here."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <EnvBadge environment={run.environment} />
                <span className="font-mono text-[10px] text-muted">{run.id}</span>
              </div>
              <div className="grid grid-cols-4 gap-2 text-center">
                {(["pass", "fail", "inconclusive", "error"] as const).map((v) => {
                  const n = run.results.filter((r) => r.verdict === v).length;
                  const colors = { pass: "text-success", fail: "text-danger", inconclusive: "text-warning", error: "text-muted" };
                  return (
                    <div key={v} className="rounded-md border border-border bg-surface/60 py-2">
                      <div className={clsx("text-lg font-semibold tabular-nums", colors[v])}>{n}</div>
                      <div className="text-[9px] uppercase tracking-wider text-muted">{v}</div>
                    </div>
                  );
                })}
              </div>
              <table className="w-full text-xs">
                <tbody>
                  {run.results.map((r) => {
                    const t = testById.get(r.testId);
                    return (
                      <tr
                        key={r.testId}
                        className="cursor-pointer border-b border-border/50 last:border-0 hover:bg-surface/50"
                        onClick={() => setSelected(r)}
                      >
                        <td className="py-2 font-mono text-[10px] text-muted">{r.testId}</td>
                        <td className="max-w-0 truncate py-2 pr-2">{t?.title}</td>
                        <td className="py-2 text-right">
                          <VerdictBadge verdict={r.verdict} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[10px] text-muted">
                Click a row for full evidence: decisions, canary check, action check and the
                sanitized response.
              </p>
            </div>
          )}
        </Card>
      </div>

      <EvidenceDrawer
        result={selected}
        test={selected ? testById.get(selected.testId) ?? null : null}
        environment={run?.environment ?? environment}
        open={selected !== null}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
