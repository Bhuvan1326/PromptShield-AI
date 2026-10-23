import { useEffect, useState } from "react";
import { Trophy } from "lucide-react";
import type { BenchmarkRun, Environment } from "@shared/types";
import { api, type BenchmarkCompare } from "../lib/api";
import { fmtTime, pct } from "../lib/format";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  EmptyState,
  EnvBadge,
  ErrorBanner,
  SectionTitle,
  Spinner,
  Tag,
} from "../components/ui";

export default function Benchmark({ ctx }: { ctx: AppContext }) {
  const [runs, setRuns] = useState<BenchmarkRun[]>([]);
  const [formula, setFormula] = useState("");
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [cmp, setCmp] = useState<BenchmarkCompare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function refresh() {
    api.benchmarks().then((d) => {
      setRuns(d.runs);
      setFormula(d.scoringFormula);
      if (d.runs[0]) setA((x) => x || d.runs[0].id);
      if (d.runs[1]) setB((x) => x || d.runs[1].id);
    }).catch((e) => setError(e.message));
  }
  useEffect(refresh, []);

  async function runBench(env: Environment) {
    setBusy(true);
    setError(null);
    try {
      await api.runBenchmark(env, "full");
      refresh();
      ctx.triggerRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Benchmark failed");
    } finally {
      setBusy(false);
    }
  }

  async function compare() {
    try {
      setCmp(await api.compareBenchmarks(a, b));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compare failed");
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Benchmark Arena</h1>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            Reproducible runs with a transparent weighted score, config fingerprints and
            versioned fixtures. Deterministic only — no claimed external rankings.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => runBench("baseline")} disabled={busy}>Benchmark baseline</Button>
          <Button onClick={() => runBench("defended")} disabled={busy}>
            {busy ? <Spinner /> : "Benchmark defended"}
          </Button>
        </div>
      </header>
      {error && <ErrorBanner message={error} />}

      <Card className="p-3">
        <div className="flex items-start gap-2 text-2xs leading-relaxed text-muted">
          <Trophy size={13} className="mt-0.5 shrink-0 text-warning" />
          <span><span className="font-medium text-foreground">Scoring:</span> {formula}</span>
        </div>
      </Card>

      {runs.length === 0 ? (
        <EmptyState title="No benchmark runs yet" hint="Run a benchmark on baseline or defended — each records a fingerprint, fixture/evaluator versions and a transparent score." />
      ) : (
        <Card className="overflow-hidden">
          <SectionTitle title="Recorded benchmarks" subtitle={`${runs.length} — fingerprints make configs comparable`} />
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted">
                <th scope="col" className="px-4 py-2 font-medium">ID</th>
                <th scope="col" className="px-4 py-2 font-medium">Env</th>
                <th scope="col" className="px-4 py-2 font-medium">Score</th>
                <th scope="col" className="px-4 py-2 font-medium">ASR</th>
                <th scope="col" className="px-4 py-2 font-medium">Block</th>
                <th scope="col" className="px-4 py-2 font-medium">Fingerprint</th>
                <th scope="col" className="px-4 py-2 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border/50">
                  <td className="px-4 py-1.5 font-mono text-accent">{r.id.slice(0, 20)}</td>
                  <td className="px-4 py-1.5"><EnvBadge environment={r.environment} /></td>
                  <td className="px-4 py-1.5 font-semibold tabular-nums">{r.score ?? "n/a"}</td>
                  <td className="px-4 py-1.5 font-mono text-2xs">{pct(r.metrics.attackSuccessRate)}</td>
                  <td className="px-4 py-1.5 font-mono text-2xs">{pct(r.metrics.defenseBlockRate)}</td>
                  <td className="px-4 py-1.5 font-mono text-2xs text-muted" title="config fingerprint (suite+tests+env+versions)">
                    {r.fingerprint}
                  </td>
                  <td className="px-4 py-1.5 text-2xs text-muted">{fmtTime(r.at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {runs.length >= 2 && (
        <Card className="p-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-2xs text-muted">
              A <select aria-label="Benchmark A" value={a} onChange={(e) => setA(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1 font-mono text-2xs">
                {runs.map((r) => <option key={r.id} value={r.id}>{r.environment} · {fmtTime(r.at)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-2xs text-muted">
              B <select aria-label="Benchmark B" value={b} onChange={(e) => setB(e.target.value)} className="rounded-md border border-border bg-card px-2 py-1 font-mono text-2xs">
                {runs.map((r) => <option key={r.id} value={r.id}>{r.environment} · {fmtTime(r.at)}</option>)}
              </select>
            </label>
            <Button variant="ghost" onClick={compare} disabled={!a || !b}>Compare</Button>
          </div>
          {cmp && (
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div className="rounded-md border border-border bg-card p-3">
                <div className="text-2xs text-muted">Δ score</div>
                <div className="text-lg font-semibold tabular-nums">{cmp.deltas.score === null ? "n/a" : `${cmp.deltas.score >= 0 ? "+" : ""}${cmp.deltas.score.toFixed(1)}`}</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <div className="text-2xs text-muted">Δ ASR</div>
                <div className="text-lg font-semibold tabular-nums">{cmp.deltas.attackSuccessRate === null ? "n/a" : `${cmp.deltas.attackSuccessRate >= 0 ? "+" : ""}${(cmp.deltas.attackSuccessRate * 100).toFixed(0)}pts`}</div>
              </div>
              <div className="rounded-md border border-border bg-card p-3">
                <div className="text-2xs text-muted">Same config</div>
                <div className="mt-1">{cmp.sameConfiguration ? <Tag>identical fingerprint</Tag> : <Tag>different config</Tag>}</div>
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
