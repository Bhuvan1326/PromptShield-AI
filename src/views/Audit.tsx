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
  investigation_requested: "text-violet",
  investigation_completed: "text-violet",
  investigation_failed: "text-warning",
};

export default function Audit({ ctx }: { ctx: AppContext }) {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

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
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold">Audit Trail</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
            Every harness action is recorded: runs, test executions, findings, exports,
            investigations and resets. No raw prompt content or canary values are logged.
          </p>
        </div>
        <Button variant="danger" onClick={reset} disabled={busy}>
          <Trash2 size={12} />
          {confirming ? "Click again to confirm reset" : "Reset all data"}
        </Button>
      </header>

      {error && <ErrorBanner message={error} />}

      {!events ? (
        <Spinner label="Loading audit log…" />
      ) : events.length === 0 ? (
        <EmptyState title="Audit log is empty" hint="Harness actions will appear here." />
      ) : (
        <Card className="p-0">
          <div className="border-b border-border px-4 py-3">
            <SectionTitle title={`${events.length} events`} subtitle="Newest first · capped at 500 entries" />
          </div>
          <table className="w-full text-xs">
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-border/40 last:border-0 hover:bg-surface/40">
                  <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-muted">
                    {fmtTime(e.at)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`font-mono text-[10px] font-medium ${typeColors[e.type] ?? "text-muted"}`}>
                      {e.type}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    {e.environment && <EnvBadge environment={e.environment} />}
                  </td>
                  <td className="px-4 py-2.5 text-[11px] text-foreground/85">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
