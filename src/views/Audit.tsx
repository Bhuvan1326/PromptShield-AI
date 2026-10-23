import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { AuditEvent } from "@shared/types";
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
  Spinner,
} from "../components/ui";

const typeColors: Record<string, string> = {
  run_created: "text-accent",
  run_finished: "text-accent",
  test_executed: "text-muted",
  finding_created: "text-danger",
  report_exported: "text-indigo",
  data_reset: "text-warning",
  investigation_requested: "text-indigo",
  investigation_completed: "text-indigo",
  investigation_failed: "text-warning",
};

const PAGE = 100;

export default function Audit({ ctx }: { ctx: AppContext }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(PAGE);

  const load = () => api.audit().then(setEvents).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [ctx.refreshSignal]);

  async function reset() {
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 4000);
      return;
    }
    setBusy(true);
    try {
      await api.reset();
      setConfirming(false);
      ctx.triggerRefresh();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">Audit trail</h1>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            Engineering event stream: runs, executions, findings, exports, investigations
            and resets. No raw prompt content or canary values are logged.
          </p>
        </div>
        <Button variant="danger" onClick={reset} disabled={busy}>
          <Trash2 size={11} />
          {confirming ? "Confirm reset" : "Reset all data"}
        </Button>
      </header>

      {error && <ErrorBanner message={error} />}

      {!events ? (
        <Spinner label="Loading audit log…" />
      ) : events.length === 0 ? (
        <EmptyState title="Audit log is empty" hint="Harness actions will appear here." />
      ) : (
        <Card className="overflow-hidden">
          <SectionTitle
            title={`${events.length} events`}
            subtitle="Newest first · capped at 500 entries"
          />
          <div className="divide-y divide-border/40">
            {events.slice(0, shown).map((e) => (
              <div
                key={e.id}
                className="flex items-baseline gap-4 px-4 py-2 font-mono text-2xs hover:bg-card/40"
              >
                <span className="shrink-0 tabular-nums text-muted">{fmtTime(e.at)}</span>
                <span className={`w-44 shrink-0 ${typeColors[e.type] ?? "text-muted"}`}>
                  {e.type}
                </span>
                <span className="shrink-0">
                  {e.environment ? <EnvBadge environment={e.environment} /> : <span className="text-muted/40">—</span>}
                </span>
                {e.testId && <span className="shrink-0 text-muted">{e.testId}</span>}
                <span className="min-w-0 truncate font-sans text-xs text-foreground/80">
                  {e.detail}
                </span>
              </div>
            ))}
          </div>
          {events.length > shown && (
            <div className="border-t border-border px-4 py-2">
              <Button variant="ghost" onClick={() => setShown((s) => s + PAGE)}>
                Show more ({events.length - shown} remaining)
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
