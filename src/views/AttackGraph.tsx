import { useEffect, useMemo, useState } from "react";
import { Route as RouteIcon, X } from "lucide-react";
import { clsx } from "clsx";
import type { AttackGraph, GraphNode, RunRecord } from "@shared/types";
import { api } from "../lib/api";
import type { AppContext } from "../App";
import {
  Card,
  EmptyState,
  ErrorBanner,
  SectionTitle,
  Spinner,
  Tag,
} from "../components/ui";

/** Column order = conceptual attack stage. */
const STAGE: Record<GraphNode["type"], number> = {
  entry: 0,
  untrusted_input: 1,
  technique: 2,
  action_attempt: 3,
  data_access: 3,
  policy_decision: 4,
  outcome: 5,
};
const STAGE_LABEL = ["entry", "input", "technique", "attempt", "policy", "outcome"];
const TYPE_COLOR: Record<GraphNode["type"], string> = {
  entry: "fill-[#1b2b45] stroke-accent/50",
  untrusted_input: "fill-[#1b2b45] stroke-border",
  technique: "fill-[#241a38] stroke-indigo/60",
  action_attempt: "fill-[#33210f] stroke-warning/60",
  data_access: "fill-[#33150f] stroke-danger/70",
  policy_decision: "fill-[#0f2b22] stroke-success/50",
  outcome: "fill-[#1b2b45] stroke-foreground/40",
};

export default function AttackGraphView({ ctx: _ctx }: { ctx: AppContext }) {
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [runId, setRunId] = useState<string>("");
  const [graph, setGraph] = useState<AttackGraph | null>(null);
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listRuns().then(async (summaries) => {
      const full = await Promise.all(summaries.slice(0, 15).map((s) => api.getRun(s.id)));
      setRuns(full);
      if (full[0]) setRunId(full[0].id);
    }).catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!runId) return;
    api.runGraph(runId).then(setGraph).catch((e) => setError(e.message));
  }, [runId]);

  // Layout: lanes per test, columns per stage.
  const layout = useMemo(() => {
    if (!graph) return null;
    const pos = new Map<string, { x: number; y: number }>();
    const lanes = new Map<string, number>();
    const stageCount = new Map<string, number>(); // "testId:stage" → offset
    let lane = 0;
    const order: GraphNode[] = [];
    for (const n of graph.nodes) {
      const key = n.testId ?? "__global";
      if (!lanes.has(key)) lanes.set(key, lane++);
      const sk = `${key}:${STAGE[n.type]}`;
      const off = stageCount.get(sk) ?? 0;
      stageCount.set(sk, off + 1);
      pos.set(n.id, {
        x: 40 + STAGE[n.type] * 150,
        y: 60 + lanes.get(key)! * 110 + off * 46,
      });
      order.push(n);
    }
    const height = Math.max(160, 60 + lane * 110 + Math.max(0, ...[...stageCount.values()].map((v) => v * 46)));
    return { pos, height };
  }, [graph]);

  if (error) return <ErrorBanner message={error} />;
  if (!runs) return <Spinner label="Loading runs…" />;
  if (runs.length === 0)
    return <EmptyState title="No runs to visualize" hint="Run a suite or an agent session first — the graph is built from recorded execution events." />;

  const inChain = new Set(graph?.chains.flatMap((c) => c.steps) ?? []);

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Attack Graph</h1>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            Nodes and edges are built from recorded execution events. Dashed edges are
            temporal inference — labeled, never asserted as proven causality.
          </p>
        </div>
        <label className="flex items-center gap-2 text-2xs text-muted">
          Run
          <select
            aria-label="Select run for attack graph"
            value={runId}
            onChange={(e) => setRunId(e.target.value)}
            className="rounded-md border border-border bg-card px-2 py-1 font-mono text-2xs"
          >
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id.slice(0, 22)} · {r.environment} · {r.suite}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="overflow-x-auto">
          <SectionTitle
            title="Observed event graph"
            subtitle={graph ? `${graph.nodes.length} nodes · ${graph.edges.length} edges · ${graph.chains.length} verified chain(s)` : ""}
          />
          {!graph ? (
            <Spinner label="Building graph…" />
          ) : graph.nodes.length === 0 ? (
            <EmptyState title="Empty graph" hint="This run recorded no graphable events." />
          ) : (
            <svg
              viewBox={`0 0 920 ${layout!.height}`}
              className="min-w-[720px] w-full"
              role="img"
              aria-label={`Attack graph: ${graph.nodes.length} observed events, ${graph.chains.length} verified attack chains`}
            >
              {STAGE_LABEL.map((s, i) => (
                <text key={s} x={40 + i * 150 + 40} y={30} className="fill-muted" fontSize={9} fontFamily="ui-monospace" textAnchor="middle">
                  {s.toUpperCase()}
                </text>
              ))}
              {graph.edges.map((e, i) => {
                const p1 = layout!.pos.get(e.from);
                const p2 = layout!.pos.get(e.to);
                if (!p1 || !p2) return null;
                return (
                  <line
                    key={i}
                    x1={p1.x + 80}
                    y1={p1.y + 14}
                    x2={p2.x}
                    y2={p2.y + 14}
                    className="stroke-border"
                    strokeWidth={1}
                    strokeDasharray={e.inferred ? "4 3" : undefined}
                  />
                );
              })}
              {graph.nodes.map((n) => {
                const p = layout!.pos.get(n.id)!;
                const chained = inChain.has(n.id);
                return (
                  <g key={n.id} transform={`translate(${p.x},${p.y})`}>
                    <rect
                      width={140}
                      height={28}
                      rx={5}
                      aria-hidden="true"
                      onClick={() => setSelected(n)}
                      className={clsx(TYPE_COLOR[n.type], chained && "stroke-danger", "cursor-pointer")}
                      strokeWidth={chained ? 1.5 : 1}
                    />
                    <text x={8} y={17} fontSize={9.5} className="fill-foreground" fontFamily="ui-monospace">
                      {n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          )}
        </Card>

        <div className="space-y-3">
          {graph && graph.chains.length > 0 && (
            <Card>
              <SectionTitle title="Verified chains" subtitle="observed compromise paths" />
              <div className="space-y-2 p-3">
                {graph.chains.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setSelected(graph.nodes.find((n) => n.id === c.steps[0]) ?? null)}
                    className="w-full rounded-md border border-danger/30 bg-danger/5 p-2.5 text-left text-xs hover:border-danger/50"
                  >
                    <div className="flex items-center gap-1.5 font-medium">
                      <RouteIcon size={11} className="text-danger" /> {c.label}
                      <Tag>{c.severity}</Tag>
                    </div>
                    <p className="mt-1 text-2xs leading-relaxed text-muted">{c.summary}</p>
                  </button>
                ))}
              </div>
            </Card>
          )}

          {graph && (
            <Card>
              <SectionTitle title="All nodes" subtitle="keyboard-accessible alternative to the graph" />
              <ul className="max-h-48 space-y-0.5 overflow-y-auto p-2">
                {graph.nodes.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => setSelected(n)}
                      className={clsx(
                        "w-full rounded px-2 py-1 text-left font-mono text-2xs hover:bg-card",
                        selected?.id === n.id ? "bg-accent/10 text-accent" : "text-foreground/80",
                      )}
                    >
                      <span className="text-indigo">{n.type}</span> {n.label}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card>
            <SectionTitle title="Node detail" />
            {!selected ? (
              <p className="p-3 text-2xs text-muted">Select a node for its recorded evidence.</p>
            ) : (
              <div className="space-y-2 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <Tag>{selected.type}</Tag>
                  <button onClick={() => setSelected(null)} aria-label="Close node detail" className="text-muted hover:text-foreground">
                    <X size={13} />
                  </button>
                </div>
                <div className="font-medium">{selected.label}</div>
                <div className="font-mono text-2xs text-muted">{selected.id}</div>
                {selected.outcome && <div className="text-2xs">outcome: <span className="font-mono">{selected.outcome}</span></div>}
                {selected.testId && <div className="text-2xs">test: <span className="font-mono text-accent">{selected.testId}</span></div>}
                {selected.evidence?.map((e, i) => (
                  <pre key={i} className="whitespace-pre-wrap rounded border border-border bg-card p-2 font-mono text-2xs text-foreground/80">{e}</pre>
                ))}
              </div>
            )}
          </Card>
          <p className="px-1 text-2xs leading-relaxed text-muted">
            Dashed edges = temporal inference between adjacent recorded events. Solid =
            directly observed relationship. Chain detection requires verified compromise
            signals (canary disclosure or action execution).
          </p>
        </div>
      </div>
    </div>
  );
}
