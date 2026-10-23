import { useMemo, useState } from "react";
import { Copy, Play, Scale, ShieldAlert, ShieldCheck } from "lucide-react";
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
  MonoBlock,
  SectionTitle,
  SegmentedControl,
  Spinner,
  Tag,
  VerdictBadge,
} from "../components/ui";
import { EvidenceDrawer } from "../components/EvidenceDrawer";

type CaseResults = Partial<Record<Environment, ExecutionResult>>;

export default function TestLab({ ctx }: { ctx: AppContext }) {
  const environment = ctx.environment;
  const [suiteId, setSuiteId] = useState("full");
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [run, setRun] = useState<RunRecord | null>(null);
  const [caseResults, setCaseResults] = useState<Record<string, CaseResults>>({});
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ result: ExecutionResult; env: Environment } | null>(null);
  const [copied, setCopied] = useState(false);

  const testById = useMemo(
    () => new Map(ctx.catalog.testCases.map((t) => [t.id, t])),
    [ctx.catalog],
  );
  const suite = ctx.catalog.suites.find((s) => s.id === suiteId) ?? ctx.catalog.suites[0];
  const suiteTests = suite.testIds
    .map((id) => testById.get(id))
    .filter((t): t is TestCase => Boolean(t));
  const selected =
    (selectedTestId && testById.get(selectedTestId)) || suiteTests[0] || null;
  const selectedResults: CaseResults = selected ? caseResults[selected.id] ?? {} : {};

  function absorbResults(r: RunRecord) {
    setRun(r);
    setCaseResults((prev) => {
      const next = { ...prev };
      for (const res of r.results) {
        next[res.testId] = { ...next[res.testId], [r.environment]: res };
      }
      return next;
    });
  }

  async function doRun(fn: () => Promise<RunRecord>, key: string) {
    setRunning(key);
    setError(null);
    try {
      absorbResults(await fn());
      ctx.triggerRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(null);
    }
  }

  async function runSelected(env: Environment) {
    if (!selected) return;
    await doRun(() => api.runTest(env, selected.id), `case:${env}`);
  }

  async function compareSelected() {
    if (!selected) return;
    await doRun(() => api.runTest("baseline", selected.id), "compare:baseline");
    await doRun(() => api.runTest("defended", selected.id), "compare:defended");
  }

  async function copyText(text: string) {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const comparing = running?.startsWith("compare") ?? false;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Test Lab</h1>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            Execute curated deterministic cases against an isolated simulator. Verdicts are
            scored from observed behavior — canary disclosure, action execution, refusal —
            never assumed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            options={[
              { value: "baseline", label: "Baseline" },
              { value: "defended", label: "Defended" },
            ]}
            value={environment}
            onChange={ctx.setEnvironment}
          />
          <Button
            onClick={() => doRun(() => api.runSuite(environment, suite.id), "suite")}
            disabled={running !== null}
          >
            {running === "suite" ? <Spinner /> : <><Play size={11} /> Run suite</>}
          </Button>
        </div>
      </header>

      {environment === "baseline" && (
        <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-2xs leading-relaxed text-warning">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          Baseline is deliberately vulnerable and only handles mock synthetic data inside the
          isolated simulator. It cannot touch real systems and says nothing about real model
          behavior.
        </div>
      )}
      {error && <ErrorBanner message={error} />}

      <div className="grid gap-4 xl:grid-cols-[220px_minmax(0,1fr)_300px] lg:grid-cols-[200px_minmax(0,1fr)]">
        {/* Left: suite + scenario selector */}
        <div className="space-y-3">
          <Card>
            <SectionTitle title="Suites" />
            <div className="p-1.5">
              {ctx.catalog.suites.map((s) => (
                <button
                  key={s.id}
                  onClick={() => {
                    setSuiteId(s.id);
                    setSelectedTestId(s.testIds[0] ?? null);
                  }}
                  className={clsx(
                    "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-xs transition-colors",
                    s.id === suite.id
                      ? "bg-card text-foreground"
                      : "text-muted hover:bg-card/60 hover:text-foreground",
                  )}
                  title={s.description}
                >
                  <span className="truncate">{s.name}</span>
                  <span className="font-mono text-2xs text-muted">{s.testIds.length}</span>
                </button>
              ))}
            </div>
          </Card>

          <Card>
            <SectionTitle title="Scenarios" subtitle={suite.name} />
            <div className="max-h-[420px] overflow-y-auto p-1.5">
              {suiteTests.map((t) => {
                const results = caseResults[t.id] ?? {};
                return (
                  <button
                    key={t.id}
                    onClick={() => setSelectedTestId(t.id)}
                    className={clsx(
                      "flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left transition-colors",
                      selected?.id === t.id
                        ? "border-accent/40 bg-card"
                        : "border-transparent hover:bg-card/60",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-2xs text-muted">{t.id}</span>
                      <LabelBadge label={t.label} />
                    </div>
                    <span className="text-2xs font-medium leading-snug text-foreground/90">
                      {t.title}
                    </span>
                    {(results.baseline || results.defended) && (
                      <span className="flex gap-1.5">
                        {results.baseline && (
                          <span className="flex items-center gap-1 text-2xs text-muted">
                            <span className="font-mono">base</span>
                            <VerdictBadge verdict={results.baseline.verdict} />
                          </span>
                        )}
                        {results.defended && (
                          <span className="flex items-center gap-1 text-2xs text-muted">
                            <span className="font-mono">def</span>
                            <VerdictBadge verdict={results.defended.verdict} />
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </Card>
        </div>

        {/* Center: scenario + execution */}
        <div className="space-y-4 min-w-0">
          {selected ? (
            <Card>
              <SectionTitle
                title={selected.title}
                subtitle={selected.description}
                right={
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono text-2xs text-muted">{selected.id}</span>
                    <LabelBadge label={selected.label} />
                    <Tag>{selected.category.replace(/_/g, " ")}</Tag>
                    <Tag>risk: {selected.risk}</Tag>
                  </div>
                }
              />
              <div className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <MonoBlock label="User input" content={selected.input} className="flex-1" />
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    title="Copy input"
                    onClick={() => copyText(selected.input)}
                  >
                    <Copy size={11} /> {copied ? "Copied" : "Copy"}
                  </Button>
                </div>
                {selected.untrustedContent && (
                  <MonoBlock
                    label="Untrusted embedded content (quoted data)"
                    content={selected.untrustedContent}
                  />
                )}
                {selected.requestedAction && (
                  <MonoBlock
                    label="Requested simulated action"
                    content={selected.requestedAction}
                  />
                )}
                <MonoBlock label="Expected behavior" content={selected.expectation.description} />

                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                  <Button
                    onClick={() => runSelected(environment)}
                    disabled={running !== null}
                  >
                    {running === `case:${environment}` ? (
                      <Spinner />
                    ) : (
                      <>
                        <Play size={11} /> Run on {environment}
                      </>
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={compareSelected}
                    disabled={running !== null}
                    title="Run this case on both environments and compare outputs"
                  >
                    {comparing ? <Spinner /> : <><Scale size={11} /> Compare both</>}
                  </Button>
                  <span className="ml-auto text-2xs text-muted">
                    engine: deterministic simulator · mode:{" "}
                    <span className="font-mono">simulated</span>
                  </span>
                </div>
              </div>
            </Card>
          ) : (
            <EmptyState title="No scenario selected" />
          )}

          {/* Execution output */}
          {selected && (selectedResults.baseline || selectedResults.defended) && (
            <div
              className={clsx(
                "grid gap-4",
                selectedResults.baseline && selectedResults.defended
                  ? "md:grid-cols-2"
                  : "grid-cols-1",
              )}
            >
              {(["baseline", "defended"] as const).map((env) => {
                const r = selectedResults[env];
                if (!r) return null;
                return (
                  <ResultPanel
                    key={env}
                    env={env}
                    result={r}
                    onEvidence={() => setDrawer({ result: r, env })}
                    onRerun={() => runSelected(env)}
                    onCopy={() => copyText(r.response)}
                    rerunning={running === `case:${env}`}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Right: latest run results */}
        <Card className="h-fit xl:sticky xl:top-16 lg:col-span-2 xl:col-span-1">
          <SectionTitle
            title="Latest run"
            subtitle={
              run
                ? `${run.suite} · ${run.environment} · ${fmtMs(run.durationMs)}`
                : "No run yet this session"
            }
          />
          {!run ? (
            <div className="p-4">
              <EmptyState
                title="Nothing executed"
                hint="Run the suite or a single scenario to see scored results."
              />
            </div>
          ) : (
            <div className="p-3 space-y-3">
              <div className="flex items-center gap-2">
                <EnvBadge environment={run.environment} />
                <span className="truncate font-mono text-2xs text-muted">{run.id}</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5 text-center">
                {(["pass", "fail", "inconclusive", "error"] as const).map((v) => {
                  const n = run.results.filter((r) => r.verdict === v).length;
                  const colors = {
                    pass: "text-success",
                    fail: "text-danger",
                    inconclusive: "text-warning",
                    error: "text-muted",
                  };
                  return (
                    <div key={v} className="rounded-md border border-border bg-card py-1.5">
                      <div className={clsx("text-sm font-semibold tabular-nums", colors[v])}>
                        {n}
                      </div>
                      <div className="text-[9px] uppercase tracking-wider text-muted">{v}</div>
                    </div>
                  );
                })}
              </div>
              <div className="divide-y divide-border/50">
                {run.results.map((r) => {
                  const t = testById.get(r.testId);
                  return (
                    <button
                      key={r.testId}
                      className="flex w-full items-center justify-between gap-2 py-1.5 text-left hover:bg-card/40"
                      onClick={() => setDrawer({ result: r, env: run.environment })}
                    >
                      <span className="font-mono text-2xs text-muted">{r.testId}</span>
                      <span className="min-w-0 flex-1 truncate text-2xs text-foreground/80">
                        {t?.title}
                      </span>
                      <VerdictBadge verdict={r.verdict} />
                    </button>
                  );
                })}
              </div>
              <p className="text-2xs text-muted">
                Select a row for the evidence trail: decisions, canary check, action check and
                sanitized response.
              </p>
            </div>
          )}
        </Card>
      </div>

      <EvidenceDrawer
        result={drawer?.result ?? null}
        test={drawer ? testById.get(drawer.result.testId) ?? null : null}
        environment={drawer?.env ?? environment}
        open={drawer !== null}
        onClose={() => setDrawer(null)}
      />
    </div>
  );
}

function ResultPanel({
  env,
  result,
  onEvidence,
  onRerun,
  onCopy,
  rerunning,
}: {
  env: Environment;
  result: ExecutionResult;
  onEvidence: () => void;
  onRerun: () => void;
  onCopy: () => void;
  rerunning: boolean;
}) {
  const flags = [
    result.blocked ? "blocked" : "not blocked",
    result.canaryLeaked ? "canary leaked" : "no canary leak",
    result.actionExecuted ? "action executed" : "no action executed",
  ];
  return (
    <Card className="min-w-0">
      <SectionTitle
        title="Execution result"
        right={
          <div className="flex items-center gap-1.5">
            <EnvBadge environment={env} />
            <VerdictBadge verdict={result.verdict} />
          </div>
        }
      />
      <div className="space-y-3 p-4">
        <div className="flex items-center gap-2">
          {env === "baseline" ? (
            <ShieldAlert size={14} className="text-danger" />
          ) : (
            <ShieldCheck size={14} className="text-accent" />
          )}
          <span className="text-xs font-semibold capitalize">{env}</span>
          <span className="ml-auto font-mono text-2xs text-muted">
            {result.testId} · {fmtMs(result.durationMs)} · simulated
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {flags.map((f) => (
            <Tag key={f}>{f}</Tag>
          ))}
        </div>

        {result.errorMessage ? (
          <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-2xs text-danger">
            {result.errorMessage}
          </div>
        ) : (
          <MonoBlock label="Response (canary redacted)" content={result.response} />
        )}

        <div>
          <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted">
            Defense decisions
          </div>
          <div className="space-y-1">
            {result.decisions.map((d, i) => (
              <div
                key={i}
                className="flex items-baseline gap-2 font-mono text-2xs leading-relaxed"
              >
                <span className="text-indigo">{d.ruleId}</span>
                <span className="text-muted">·{d.outcome}·</span>
                <span className="text-foreground/70">{d.reason}</span>
              </div>
            ))}
            {result.decisions.length === 0 && (
              <p className="font-mono text-2xs text-muted">— no guardrail decisions —</p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-border pt-3">
          <Button variant="ghost" onClick={onEvidence}>
            Evidence
          </Button>
          <Button variant="ghost" onClick={onRerun} disabled={rerunning}>
            {rerunning ? <Spinner /> : "Rerun"}
          </Button>
          <Button variant="ghost" onClick={onCopy}>
            <Copy size={11} /> Copy
          </Button>
        </div>
      </div>
    </Card>
  );
}
