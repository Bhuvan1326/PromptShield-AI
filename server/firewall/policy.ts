import { createHash, randomUUID } from "node:crypto";
import { ACTION_ALLOWLIST, CANARY_VALUE } from "../engine/constants";

/**
 * RUNTIME AI SECURITY FIREWALL — policy enforcement point (PEP).
 *
 * A real, reusable server-side enforcement layer: every simulated tool call
 * passes through evaluate() immediately before execution. Decisions are
 * typed, reasoned, auditable and never delegated to model judgment.
 *
 * Two modes:
 *   - test mode:      evaluate() only — returns the decision, nothing executes.
 *   - integration:    the defended simulator calls authorizeAction() — the
 *                     same code path the API test-mode uses.
 *
 * Enforced rules (fail-closed on engine errors):
 *   R1 unknown-tool-deny      — tools outside the allowlist are denied.
 *   R2 arg-validation         — per-tool argument schemas are checked.
 *   R3 data-exfiltration      — args embedding the synthetic canary or
 *                               protected-context markers are denied.
 *   R4 approval-required      — configured sensitive actions need a
 *                               single-use approval token bound to
 *                               tool+canonical args (replay-safe).
 *   R5 execution-guard        — expired/cancelled sessions deny execution.
 */

export type PolicyResult = "allow" | "deny" | "approval_required";

export interface ToolRequest {
  tool: string;
  args: Record<string, unknown>;
  correlationId: string;
  /** Optional session id — checked against live/cancelled session state. */
  sessionId?: string;
  /** Single-use approval token obtained from the approvals endpoint. */
  approvalToken?: string;
}

export interface PolicyDecision {
  id: string;
  result: PolicyResult;
  policyId: string;
  reason: string;
  tool: string;
  at: string;
  correlationId: string;
}

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
}

/** Tools the defended assistant may invoke — mirrors the engine allowlist. */
export const TOOL_ALLOWLIST = ACTION_ALLOWLIST;

/** Approval-required actions: permitted by allowlist? No — they're sensitive
 *  and additionally need an explicit one-shot approval token. */
export const APPROVAL_REQUIRED = new Set(["export_report"]);

/** Per-tool argument contracts. Validation is server-side — model-generated
 *  arguments are never trusted. */
const ARG_SCHEMAS: Record<string, (args: Record<string, unknown>) => string | null> = {
  lookup_ticket: (a) =>
    typeof a.ticketId === "string" && /^[A-Z0-9-]{3,32}$/i.test(a.ticketId)
      ? null
      : "lookup_ticket requires args.ticketId (3-32 chars, A-Z 0-9 -)",
  create_ticket: (a) =>
    typeof a.summary === "string" && a.summary.length > 0 && a.summary.length <= 500
      ? null
      : "create_ticket requires args.summary (1-500 chars)",
  export_report: (a) =>
    a.format === undefined || ["json", "html"].includes(String(a.format))
      ? null
      : "export_report args.format must be 'json' or 'html'",
};

const PROTECTED_MARKERS = [CANARY_VALUE, "PS-CANARY", "national_id", "SYNTHETIC_PRIVATE"];

/** Session liveness registry — integration callers register/cancel sessions
 *  here; the execution guard denies calls on cancelled/expired sessions. */
const liveSessions = new Set<string>();

export function registerSession(sessionId: string) {
  liveSessions.add(sessionId);
}
export function closeSession(sessionId: string) {
  liveSessions.delete(sessionId);
}

/** Single-use approval tokens bound to a specific tool+args digest. */
interface Approval {
  digest: string;
  expiresAt: number;
  used: boolean;
}
const approvals = new Map<string, Approval>();
const APPROVAL_TTL_MS = 60_000;

function argsDigest(tool: string, args: Record<string, unknown>): string {
  const canonical = JSON.stringify(
    Object.keys(args)
      .sort()
      .map((k) => [k, args[k]]),
  );
  return createHash("sha256")
    .update(tool + ":" + canonical)
    .digest("hex");
}

export function issueApproval(
  tool: string,
  args: Record<string, unknown>,
): { token: string; expiresAt: string } {
  // Sweep expired entries to bound memory.
  const now = Date.now();
  for (const [k, v] of approvals) if (v.expiresAt <= now || v.used) approvals.delete(k);
  const token = randomUUID();
  approvals.set(token, { digest: argsDigest(tool, args), expiresAt: now + APPROVAL_TTL_MS, used: false });
  return { token, expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString() };
}

function consumeApproval(token: string, tool: string, args: Record<string, unknown>): boolean {
  const a = approvals.get(token);
  if (!a || a.used || a.expiresAt <= Date.now()) return false;
  if (a.digest !== argsDigest(tool, args)) return false; // bound to one action+args
  a.used = true; // single-use — replay denied on the next call
  return true;
}

export const POLICY_RULES: PolicyRule[] = [
  { id: "R1", name: "unknown-tool-deny", description: "Tools not on the allowlist are denied by default." },
  { id: "R2", name: "arg-validation", description: "Per-tool argument schemas enforced server-side." },
  { id: "R3", name: "data-exfiltration", description: "Arguments embedding protected markers are denied." },
  { id: "R4", name: "approval-required", description: "Sensitive actions need a single-use, action-bound approval token." },
  { id: "R5", name: "execution-guard", description: "Cancelled/expired sessions cannot execute tools." },
];

function decide(
  result: PolicyResult,
  policyId: string,
  reason: string,
  req: ToolRequest,
): PolicyDecision {
  return {
    id: `pol-${randomUUID().slice(0, 12)}`,
    result,
    policyId,
    reason,
    tool: req.tool,
    at: new Date().toISOString(),
    correlationId: req.correlationId,
  };
}

/**
 * Evaluate a tool request. Fail-closed: any internal error becomes a deny.
 * Pure — records nothing; callers persist decisions they care about.
 */
export function evaluate(req: ToolRequest): PolicyDecision {
  try {
    // R5: session guard — a sessionId that was cancelled/expired denies.
    if (req.sessionId && !liveSessions.has(req.sessionId)) {
      return decide("deny", "R5", "session expired or cancelled", req);
    }

    // R1: allowlist — unknown tools are always denied.
    if (!(TOOL_ALLOWLIST as readonly string[]).includes(req.tool) && !APPROVAL_REQUIRED.has(req.tool)) {
      return decide("deny", "R1", `tool '${req.tool}' is not on the allowlist`, req);
    }

    // R2: argument schema.
    const schema = ARG_SCHEMAS[req.tool];
    if (schema) {
      const violation = schema(req.args ?? {});
      if (violation) return decide("deny", "R2", violation, req);
    }

    // R3: protected-data exfiltration via arguments.
    const serialized = JSON.stringify(req.args ?? {});
    const marker = PROTECTED_MARKERS.find((m) => serialized.includes(m));
    if (marker) {
      return decide("deny", "R3", "arguments embed a protected-data marker", req);
    }

    // R4: approval-required sensitive action.
    if (APPROVAL_REQUIRED.has(req.tool)) {
      if (req.approvalToken && consumeApproval(req.approvalToken, req.tool, req.args ?? {})) {
        return decide("allow", "R4", "valid single-use approval presented", req);
      }
      return decide("approval_required", "R4", "action requires explicit approval", req);
    }

    return decide("allow", "R2", "tool and arguments satisfy all policies", req);
  } catch {
    // Fail closed — never allow on an engine error.
    return decide("deny", "R1", "policy engine error — denied by default", req);
  }
}

/** Convenience for engine integration: evaluate + boolean. */
export function authorizeAction(
  tool: string,
  args: Record<string, unknown>,
  correlationId: string,
  sessionId?: string,
): PolicyDecision {
  return evaluate({ tool, args, correlationId, sessionId });
}
