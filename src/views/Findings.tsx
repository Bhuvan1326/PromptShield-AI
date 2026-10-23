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
  SectionTitle,
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
    <div className="space-y-6">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-bold">Findings</h1>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
            Every failed test execution produces a finding with evidence, reproduction steps
            and remediation. Findings can be rerun, triaged, or summarized by Gemini (when
            configured — AI summaries are explanatory only, never authoritative).
          </p>
        </div>
        <select
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
        <Card className="p-0">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-[10px] uppercase tracking-wider text-muted">
                <th className="px-4 py-3">Finding</th>
                <th className="px-4 py-3">Severity</th>
                <th className="px-4 py-3">Env</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f) => (
                <tr key={f.id} className="border-b border-border/50 align-top last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium">{f.title}</p>
                    <p className="mt-0.5 font-mono text-[10px] text-muted">
                      {f.testId} · {f.category.replace(/_/g, " ")}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <SeverityBadge severity={f.severity} />
                  </td>
                  <td className="px-4 py-3">
                    <EnvBadge environment={f.environment} />
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={f.status} />
                  </td>
                  <td className="px-4 py-3 font-mono text-[10px] text-muted">
                    {fmtTime(f.createdAt)}
                  </td>
                  <td className="px-4 py-3">
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
                          Acknowledge
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
                        {investigating === f.id ? <Spinner label="" /> : <><Sparkles size={11} /> Investigate</>}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Finding detail drawer — reuse evidence drawer with a synthesized result */}
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
                  { kind: "note", label: "Finding", content: expanded.description },
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
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
          <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-5 shadow-2xl focus:outline-none">
            <div className="flex items-start justify-between">
              <Dialog.Title className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles size={14} className="text-accent" /> AI Investigation Summary
              </Dialog.Title>
              <Dialog.Close className="rounded p-1 text-muted hover:text-foreground">
                <X size={16} />
              </Dialog.Close>
            </div>
            {investigateError && (
              <div className="mt-3">
                <ErrorBanner message={investigateError} />
                <p className="mt-2 text-[11px] text-muted">
                  Set GEMINI_API_KEY in the server .env to enable this feature. Deterministic
                  results are unaffected.
                </p>
              </div>
            )}
            {investigation && (
              <div className="mt-3 space-y-3">
                <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-[10px] leading-relaxed text-warning">
                  AI-generated explanation from sanitized evidence. The deterministic harness
                  verdict remains authoritative. Model: {investigation.model}
                </div>
                <p className="whitespace-pre-wrap text-xs leading-relaxed">{investigation.explanation}</p>
                {investigation.recommendedMitigations.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted">
                      Mitigation
                    </div>
                    <p className="mt-1 text-xs text-muted">{investigation.recommendedMitigations[0]}</p>
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
