import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { RefreshCcw, Sparkles, X } from "lucide-react";
import type { Finding, InvestigationResponse } from "@shared/types";
import { api } from "../lib/api";
import { fmtTime } from "../lib/format";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  EmptyState,
  EnvBadge,
  ErrorBanner,
  SeverityBadge,
  Spinner,
  StatusBadge,
} from "../components/ui";
import { EvidenceDrawer } from "../components/EvidenceDrawer";

export default function Findings({ ctx }: { ctx: AppContext }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Finding | null>(null);
  const [investigating, setInvestigating] = useState<string | null>(null);
  const [investigation, setInvestigation] = useState<InvestigationResponse | null>(null);
  const [investigateError, setInvestigateError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    api
      .findings(filter === "all" ? undefined : filter)
      .then(setFindings)
      .catch((e) => setError(e.message));
  };
  useEffect(load, [filter, ctx.refreshSignal]);

  async function setStatus(f: Finding, status: Finding["status"]) {
    setBusyId(f.id);
    try {
      await api.updateFinding(f.id, status);
      load();
      ctx.triggerRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  }

  async function rerun(f: Finding) {
    setBusyId(f.id);
    try {
      await api.rerunFinding(f.id);
      load();
      ctx.triggerRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rerun failed");
    } finally {
      setBusyId(null);
    }
  }

  async function investigate(f: Finding) {
    setInvestigating(f.id);
    setInvestigateError(null);
    setInvestigation(null);
    try {
      setInvestigation(await api.investigate(f.id));
    } catch (e) {
      setInvestigateError(e instanceof Error ? e.message : "Investigation failed");
    } finally {
      setInvestigating(null);
    }
  }

  const testById = new Map(ctx.catalog.testCases.map((t) => [t.id, t]));

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-base font-semibold">Findings</h1>
          <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
            Every failed execution produces a finding with evidence, reproduction steps and
            remediation. AI summaries (when Gemini is configured) are explanatory only —
            deterministic verdicts stay authoritative.
          </p>
        </div>
        <select
          aria-label="Filter findings by status"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground focus:border-accent/50 focus:outline-none"
        >
          <option value="all">All statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
      </header>

      {error && <ErrorBanner message={error} />}

      {!findings ? (
        <Spinner label="Loading findings…" />
      ) : findings.length === 0 ? (
        <EmptyState
          title="No findings"
          hint="Failed executions create findings automatically. Run the suite on the baseline environment."
        />
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-2xs uppercase tracking-wider text-muted">
                <th className="px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">Test</th>
                <th className="px-4 py-2.5 font-medium">Finding</th>
                <th className="px-4 py-2.5 font-medium">Mode</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id} className="border-b border-border/50 align-top last:border-0 hover:bg-card/40">
                  <td className="px-4 py-2.5">
                    <SeverityBadge severity={f.severity} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-2xs text-muted">
                    {f.testId}
                    <div className="mt-0.5 text-muted/70">{f.category.replace(/_/g, " ")}</div>
                  </td>
                  <td className="max-w-0 px-4 py-2.5">
                    <p className="truncate font-medium text-foreground/90">{f.title}</p>
                  </td>
                  <td className="px-4 py-2.5">
                    <EnvBadge environment={f.environment} />
                  </td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={f.status} />
                  </td>
                  <td className="px-4 py-2.5 font-mono text-2xs text-muted">
                    {fmtTime(f.createdAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button variant="ghost" onClick={() => setExpanded(f)}>
                        Detail
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busyId === f.id}
                        onClick={() => rerun(f)}
                        title="Re-execute this test in the same environment; passing resolves the finding"
                      >
                        <RefreshCcw size={11} /> Rerun
                      </Button>
                      {f.status === "open" && (
                        <Button variant="ghost" disabled={busyId === f.id} onClick={() => setStatus(f, "acknowledged")}>
                          Ack
                        </Button>
                      )}
                      {f.status !== "resolved" && (
                        <Button variant="ghost" disabled={busyId === f.id} onClick={() => setStatus(f, "resolved")}>
                          Resolve
                        </Button>
                      )}
                      <Button
                        disabled={investigating === f.id}
                        onClick={() => investigate(f)}
                        title="Ask Gemini to summarize the sanitized evidence (server-side, optional)"
                      >
                        {investigating === f.id ? <Spinner /> : <><Sparkles size={11} /> Investigate</>}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Finding detail drawer — structured: observed / expected / impact / remediation / evidence */}
      <EvidenceDrawer
        result={
          expanded
            ? {
                testId: expanded.testId,
                verdict: "fail",
                response: "",
                canaryLeaked: false,
                privateDataLeaked: false,
                actionExecuted: false,
                blocked: false,
                decisions: [],
                durationMs: 0,
                evidence: [
                  { kind: "note", label: "Observed behavior", content: expanded.description },
                  {
                    kind: "note",
                    label: "Expected behavior",
                    content: testById.get(expanded.testId)?.expectation.description ?? "—",
                  },
                  {
                    kind: "note",
                    label: `Impact (${expanded.severity})`,
                    content: impactLine(expanded),
                  },
                  { kind: "note", label: "Remediation", content: expanded.remediation },
                  {
                    kind: "note",
                    label: "Reproduction",
                    content: expanded.reproductionSteps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
                  },
                  ...expanded.evidence,
                ],
              }
            : null
        }
        test={expanded ? testById.get(expanded.testId) ?? null : null}
        environment={expanded?.environment ?? "baseline"}
        open={expanded !== null}
        onClose={() => setExpanded(null)}
      />

      {/* Investigation result dialog */}
      <Dialog.Root
        open={investigation !== null || investigateError !== null}
        onOpenChange={(o) => {
          if (!o) {
            setInvestigation(null);
            setInvestigateError(null);
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-surface p-5 focus:outline-none">
            <div className="flex items-start justify-between">
              <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles size={14} className="text-accent" /> AI investigation summary
              </Dialog.Title>
              <Dialog.Close
                aria-label="Close investigation dialog"
                className="rounded p-1 text-muted hover:text-foreground"
              >
                <X size={16} />
              </Dialog.Close>
            </div>
            {investigateError && (
              <div className="mt-3">
                <ErrorBanner message={investigateError} />
                <p className="mt-2 text-2xs text-muted">
                  Set GEMINI_API_KEY in the server .env to enable this feature. Deterministic
                  results are unaffected.
                </p>
              </div>
            )}
            {investigation && (
              <div className="mt-3 space-y-3">
                <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-2xs leading-relaxed text-warning">
                  AI-generated explanation from sanitized evidence — the deterministic harness
                  verdict remains authoritative. Model: {investigation.model}
                </div>
                <p className="whitespace-pre-wrap text-xs leading-relaxed">
                  {investigation.explanation}
                </p>
                {investigation.recommendedMitigations.length > 0 && (
                  <div>
                    <div className="text-2xs font-semibold uppercase tracking-wider text-muted">
                      Mitigation
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {investigation.recommendedMitigations[0]}
                    </p>
                  </div>
                )}
              </div>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function impactLine(f: Finding): string {
  switch (f.category) {
    case "prompt_injection":
    case "indirect_injection":
      return "Untrusted input can override assistant policy and exfiltrate protected context. In a real deployment this could expose system prompts, tenant data or embedded secrets.";
    case "data_extraction":
      return "Protected context fields are disclosable on request. In a real deployment this would leak private user or configuration data.";
    case "unauthorized_action":
      return "A destructive tool ran without authorization. In a real deployment this could cause irreversible data loss or privilege abuse.";
    case "benign":
      return "A harmless request was refused — usability regression, not a vulnerability.";
    case "robustness":
      return "Malformed or oversized input was processed instead of rejected — a resource-exhaustion and stability risk.";
    default:
      return "Observed behavior violated the stated expectation.";
  }
}
