import { useEffect, useState } from "react";
import { ShieldCheck, ShieldX, Timer } from "lucide-react";
import { api, type FirewallDecision, type FirewallPolicies } from "../lib/api";
import type { AppContext } from "../App";
import {
  Button,
  Card,
  ErrorBanner,
  SectionTitle,
  Spinner,
  Tag,
} from "../components/ui";

const RESULT_STYLE = {
  allow: { icon: ShieldCheck, cls: "text-success", label: "ALLOW" },
  deny: { icon: ShieldX, cls: "text-danger", label: "DENY" },
  approval_required: { icon: Timer, cls: "text-warning", label: "APPROVAL REQUIRED" },
};

/**
 * Runtime firewall console — evaluates tool calls against the same policy
 * engine the defended simulator integrates with. Test mode only; nothing
 * executes here.
 */
export default function Firewall({ ctx: _ctx }: { ctx: AppContext }) {
  const [policies, setPolicies] = useState<FirewallPolicies | null>(null);
  const [tool, setTool] = useState("lookup_ticket");
  const [argsText, setArgsText] = useState('{"ticketId":"T-123"}');
  const [approvalToken, setApprovalToken] = useState("");
  const [decisions, setDecisions] = useState<FirewallDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.firewallPolicies().then(setPolicies).catch((e) => setError(e.message));
  }, []);

  async function evaluate() {
    setBusy(true);
    setError(null);
    try {
      let args: Record<string, unknown>;
      try {
        args = argsText.trim() ? JSON.parse(argsText) : {};
      } catch {
        setError("Arguments must be valid JSON (object).");
        setBusy(false);
        return;
      }
      const d = await api.firewallEvaluate({
        tool,
        args,
        approvalToken: approvalToken || undefined,
      });
      setDecisions((ds) => [d, ...ds].slice(0, 20));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Evaluation failed");
    } finally {
      setBusy(false);
    }
  }

  async function requestApproval() {
    setError(null);
    try {
      let args: Record<string, unknown>;
      try {
        args = argsText.trim() ? JSON.parse(argsText) : {};
      } catch {
        setError("Arguments must be valid JSON (object).");
        return;
      }
      const a = await api.firewallApprove(tool, args);
      setApprovalToken(a.token);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval request failed");
    }
  }

  if (error && !policies) return <ErrorBanner message={error} />;
  if (!policies) return <Spinner label="Loading policies…" />;

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-base font-semibold">Runtime Firewall</h1>
        <p className="mt-0.5 max-w-xl text-xs leading-relaxed text-muted">
          Server-side policy enforcement over the mock tool catalog. The defended
          simulator authorizes actions through this same engine.{" "}
          <Tag>simulated enforcement — no real tools execute</Tag>
        </p>
      </header>
      {error && <ErrorBanner message={error} />}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <SectionTitle title="Policy rules" subtitle="evaluated in order, fail-closed" />
          <div className="space-y-2 p-3">
            {policies.rules.map((r) => (
              <div key={r.id} className="rounded-md border border-border bg-card p-2.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-indigo">{r.id}</span>
                  <span className="font-medium">{r.name}</span>
                </div>
                <p className="mt-0.5 text-2xs text-muted">{r.description}</p>
              </div>
            ))}
          </div>
          <div className="space-y-1.5 px-3 pb-3 text-2xs text-muted">
            <div>tool allowlist: <span className="font-mono text-foreground">{policies.toolAllowlist.join(", ")}</span></div>
            <div>approval-required: <span className="font-mono text-foreground">{policies.approvalRequired.join(", ") || "none"}</span></div>
            <div>integration: {policies.modes.integration}</div>
            <div className="italic">{policies.limitations}</div>
          </div>
        </Card>

        <div className="space-y-4">
          <Card>
            <SectionTitle title="Evaluate a tool call" subtitle="returns the policy decision — nothing executes" />
            <div className="space-y-2 p-3">
              <label className="block text-2xs font-medium uppercase tracking-wider text-muted" htmlFor="fw-tool">Tool</label>
              <select
                id="fw-tool"
                value={tool}
                onChange={(e) => setTool(e.target.value)}
                className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs focus:border-accent/50 focus:outline-none"
              >
                {[...policies.toolAllowlist, ...policies.approvalRequired, "delete_all_users", "read_file"].map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
              <label className="block text-2xs font-medium uppercase tracking-wider text-muted" htmlFor="fw-args">Arguments (JSON)</label>
              <textarea
                id="fw-args"
                value={argsText}
                onChange={(e) => setArgsText(e.target.value)}
                rows={3}
                spellCheck={false}
                className="w-full rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-2xs focus:border-accent/50 focus:outline-none"
              />
              <label className="block text-2xs font-medium uppercase tracking-wider text-muted" htmlFor="fw-token">Approval token (if required)</label>
              <div className="flex gap-2">
                <input
                  id="fw-token"
                  value={approvalToken}
                  onChange={(e) => setApprovalToken(e.target.value)}
                  placeholder="paste single-use token"
                  className="flex-1 rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-2xs focus:border-accent/50 focus:outline-none"
                />
                <Button variant="ghost" onClick={requestApproval} disabled={!policies.approvalRequired.includes(tool)}>
                  Request approval
                </Button>
              </div>
              <Button onClick={evaluate} disabled={busy}>
                {busy ? <Spinner /> : "Evaluate"}
              </Button>
            </div>
          </Card>

          <Card>
            <SectionTitle title="Decision log" subtitle="most recent first" />
            <div className="max-h-64 space-y-1.5 overflow-y-auto p-3" aria-live="polite">
              {decisions.length === 0 && <p className="text-2xs text-muted">No evaluations yet.</p>}
              {decisions.map((d) => {
                const S = RESULT_STYLE[d.result];
                return (
                  <div key={d.id} className="flex items-start gap-2 rounded-md border border-border bg-card p-2 text-2xs">
                    <S.icon size={13} className={`mt-0.5 shrink-0 ${S.cls}`} />
                    <div className="min-w-0">
                      <div className="font-mono">
                        <span className={S.cls}>{S.label}</span>{" "}
                        <span className="text-indigo">{d.policyId}</span>{" "}
                        <span className="text-foreground">{d.tool}</span>
                      </div>
                      <div className="text-muted">{d.reason}</div>
                      <div className="text-muted/60">{d.id} · {d.correlationId}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
