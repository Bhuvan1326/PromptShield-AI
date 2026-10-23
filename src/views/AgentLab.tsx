import { useEffect, useRef, useState } from "react";
import { Bot, CircleStop, Play } from "lucide-react";
import { clsx } from "clsx";
import type { AgentPreset, AgentSession } from "@shared/types";
import { api } from "../lib/api";
import { fmtTime } from "../lib/format";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  EmptyState,
  EnvBadge,
  ErrorBanner,
  SectionTitle,
  SegmentedControl,
  Spinner,
  Tag,
} from "../components/ui";

const OUTCOME_STYLE: Record<string, string> = {
  success: "text-danger",
  blocked: "text-success",
  other: "text-muted",
};

export default function AgentLab({ ctx }: { ctx: AppContext }) {
  const [preset, setPreset] = useState<AgentPreset>("standard");
  const [session, setSession] = useState<AgentSession | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    api
      .agentSessions()
      .then(setSessions)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load sessions"));
    return () => { if (poll.current) clearInterval(poll.current); };
  }, []);

  function startPolling(id: string) {
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const s = await api.agentSession(id);
        setSession(s);
        if (s.status !== "running" && poll.current) {
          clearInterval(poll.current);
          poll.current = null;
          api.agentSessions().then(setSessions).catch(() => {});
          ctx.triggerRefresh();
        }
      } catch { /* transient poll failure — keep polling */ }
    }, 700);
  }

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.startAgent(ctx.environment, preset);
      setSession(s);
      startPolling(s.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start agent");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!session) return;
    try {
      await api.cancelAgent(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Cancel failed");
    }
  }

  const budgetPct = session
    ? Math.round((session.budget.stepsUsed / session.budget.maxSteps) * 100)
    : 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Red Team Agent</h1>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            Bounded autonomous attack loop — plan → select → execute → observe → evaluate
            → update — over the approved fixture catalog only.{" "}
            <Tag>sandboxed · simulated pacing</Tag>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <SegmentedControl
            options={[
              { value: "quick", label: "Quick" },
              { value: "standard", label: "Standard" },
              { value: "deep", label: "Deep" },
            ]}
            value={preset}
            onChange={(v) => setPreset(v as AgentPreset)}
          />
          <EnvBadge environment={ctx.environment} />
          <Button onClick={start} disabled={busy || session?.status === "running"}>
            {busy ? <Spinner /> : <><Play size={11} /> Start agent</>}
          </Button>
          {session?.status === "running" && (
            <Button variant="danger" onClick={cancel}>
              <CircleStop size={11} /> Stop
            </Button>
          )}
        </div>
      </header>
      {error && <ErrorBanner message={error} />}

      {!session && sessions.length === 0 && (
        <EmptyState
          title="No agent sessions yet"
          hint="Start a bounded red-team session — the agent picks strategies from the approved test catalog and adapts based on observed results."
        />
      )}

      {session && (
        <Card>
          <SectionTitle
            title={`Session ${session.id} — ${session.status}${session.planningSource === "gemini" ? " · gemini-assisted" : ""}`}
            subtitle={session.stopReason ? `stop reason: ${session.stopReason}` : `${PRESET_LABEL[session.preset]} · ${session.environment}`}
            right={
              <span className="flex items-center gap-2">
                <Bot size={13} className="text-accent" />
                {session.planningSource === "gemini" && <Tag>AI-assisted</Tag>}
              </span>
            }
          />
          <div className="grid gap-4 p-4 lg:grid-cols-[240px_minmax(0,1fr)]">
            <div className="space-y-3 text-xs">
              <div>
                <div className="mb-1 flex justify-between text-2xs text-muted">
                  <span>Step budget</span>
                  <span className="font-mono">{session.budget.stepsUsed}/{session.budget.maxSteps}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded bg-card">
                  <div
                    className="h-full bg-accent transition-all"
                    style={{ width: `${budgetPct}%` }}
                    role="progressbar"
                    aria-valuenow={budgetPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Step budget used"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 text-center">
                <div className="rounded border border-border bg-card py-2">
                  <div className="text-base font-semibold tabular-nums">{session.attemptedTestIds.length}</div>
                  <div className="text-2xs text-muted">attempts</div>
                </div>
                <div className="rounded border border-border bg-card py-2">
                  <div className="text-base font-semibold tabular-nums text-danger">{session.successfulTestIds.length}</div>
                  <div className="text-2xs text-muted">verified attacks</div>
                </div>
                <div className="rounded border border-border bg-card py-2">
                  <div className="text-base font-semibold tabular-nums text-success">{session.blockedCount}</div>
                  <div className="text-2xs text-muted">defense blocks</div>
                </div>
                <div className="rounded border border-border bg-card py-2">
                  <div className="text-base font-semibold tabular-nums">{session.findings.length}</div>
                  <div className="text-2xs text-muted">findings</div>
                </div>
              </div>
              {session.currentStrategy && (
                <p className="text-2xs text-muted">
                  active strategy: <span className="font-mono text-foreground">{session.currentStrategy}</span>
                </p>
              )}
            </div>
            {/* Compact SR announcement — announces step transitions only,
                not the full re-rendered list (avoids announcement flooding). */}
            <div role="status" aria-live="polite" className="sr-only">
              {session.trace.length > 0 &&
                `Step ${session.budget.stepsUsed} of ${session.budget.maxSteps} — ${session.trace[session.trace.length - 1]?.detail ?? ""}`}
            </div>
            <div
              className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-border bg-card p-2 font-mono text-2xs"
              aria-label="Agent activity timeline"
            >
              {session.trace.map((t) => (
                <div key={t.step} className="flex items-baseline gap-2 leading-relaxed">
                  <span className="w-6 shrink-0 text-right text-muted">#{t.step}</span>
                  <span className="w-16 shrink-0 text-indigo">{t.phase}</span>
                  <span className={clsx("shrink-0", t.outcome ? OUTCOME_STYLE[t.outcome] : "text-muted")}>
                    {t.outcome ?? "·"}
                  </span>
                  <span className="text-foreground/80">{t.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {sessions.length > 0 && (
        <Card className="overflow-hidden">
          <SectionTitle title="Recent sessions" subtitle={`${sessions.length} recorded`} />
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted">
                <th scope="col" className="px-4 py-2 font-medium">Session</th>
                <th scope="col" className="px-4 py-2 font-medium">Env</th>
                <th scope="col" className="px-4 py-2 font-medium">Preset</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 font-medium">Steps</th>
                <th scope="col" className="px-4 py-2 font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 10).map((s) => (
                <tr
                  key={s.id}
                  onClick={() => setSession(s)}
                  className="cursor-pointer border-b border-border/50 hover:bg-card"
                >
                  <td className="px-4 py-2 font-mono text-accent">{s.id.slice(0, 20)}…</td>
                  <td className="px-4 py-2"><EnvBadge environment={s.environment} /></td>
                  <td className="px-4 py-2 text-muted">{s.preset}</td>
                  <td className="px-4 py-2">{s.status}</td>
                  <td className="px-4 py-2 font-mono">{s.budget.stepsUsed}/{s.budget.maxSteps}</td>
                  <td className="px-4 py-2 text-muted">{fmtTime(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

const PRESET_LABEL: Record<string, string> = {
  quick: "Quick Scan · 4 steps / 15s",
  standard: "Standard Scan · 8 steps / 45s",
  deep: "Deep Scan · 12 steps / 90s",
};
