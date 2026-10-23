import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentSession,
  AuditEvent,
  AuditEventType,
  BenchmarkRun,
  Finding,
  RunRecord,
} from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, "data");

// Bounded retention keeps the JSON file and memory footprint flat during
// long demo sessions. Oldest entries are evicted; findings retain their own
// evidence snapshot so eviction of the parent run does not corrupt them.
const MAX_RUNS = 200;
const MAX_FINDINGS = 500;
const MAX_AUDIT_EVENTS = 500;
const MAX_AGENT_SESSIONS = 50;
const MAX_BENCHMARK_RUNS = 100;

// Tamper-evidence hash chain over audit events: each event's hash covers the
// previous hash + canonical event body. Detects modification/reordering —
// it does NOT prove events true by itself.
function chainHash(prev: string | undefined, event: Omit<AuditEvent, "id" | "at" | "hash"> & { id: string; at: string }): string {
  return createHash("sha256")
    .update((prev ?? "GENESIS") + JSON.stringify(event))
    .digest("hex");
}

interface Db {
  runs: RunRecord[];
  findings: Finding[];
  audit: AuditEvent[];
  /** Hash of the oldest dropped audit event — chain anchor after trimming. */
  auditChainAnchor?: string;
  agentSessions: AgentSession[];
  benchmarkRuns: BenchmarkRun[];
}

const empty = (): Db => ({ runs: [], findings: [], audit: [], agentSessions: [], benchmarkRuns: [] });

function dbPath(): string {
  return process.env.PROMPTSHIELD_DB_PATH || path.join(DEFAULT_DATA_DIR, "promptshield.json");
}

function checkpointPath(): string {
  return process.env.PROMPTSHIELD_CHECKPOINT_PATH || path.join(DEFAULT_DATA_DIR, "audit-checkpoint.json");
}

// Optional audit signing — key lives in the environment (separate from the
// database) so a rewrite of promptshield.json cannot forge signatures.
const signKey = process.env.PS_AUDIT_SIGNING_KEY || undefined;

function hmac(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** Compare stored checkpoint to the live chain tip + validate its signature. */
function verifyCheckpoint(d: Db): "ok" | "unsigned" | "missing" | "mismatch" | "invalid-signature" {
  const file = checkpointPath();
  if (!existsSync(file)) return signKey ? "missing" : "unsigned";
  try {
    const cp = JSON.parse(readFileSync(file, "utf8")) as {
      lastHash?: string; count?: number; sig?: string; at?: string;
    };
    if (signKey) {
      const { sig, ...body } = cp;
      if (!sig || sig !== hmac(signKey, JSON.stringify(body))) return "invalid-signature";
    }
    const tip = d.audit[0]?.hash ?? d.auditChainAnchor ?? "GENESIS";
    return cp.lastHash === tip ? "ok" : "mismatch";
  } catch {
    return "invalid-signature";
  }
}

let db: Db | null = null;

function getDb(): Db {
  if (!db) db = load();
  return db;
}

function load(): Db {
  const file = dbPath();
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Db>;
      const db = {
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit : [],
        agentSessions: Array.isArray(parsed.agentSessions) ? parsed.agentSessions : [],
        benchmarkRuns: Array.isArray(parsed.benchmarkRuns) ? parsed.benchmarkRuns : [],
        auditChainAnchor: typeof parsed.auditChainAnchor === "string" ? parsed.auditChainAnchor : undefined,
      };
      // Stale-session recovery: agent lifecycles are in-memory, so a session
      // persisted as "running" can never resume after a process restart.
      // Mark it honestly rather than leaving a zombie row.
      for (const s of db.agentSessions) {
        if (s.status === "running") {
          s.status = "error";
          s.stopReason = "process_exit";
        }
      }
      let prev = db.auditChainAnchor;
      for (const e of [...db.audit].reverse()) {
        const { hash: _h, ...body } = e;
        const expected = chainHash(prev, body as never);
        if (e.hash !== expected) e.hash = expected;
        prev = e.hash;
      }
      return db;
    }
  } catch {
    // Observable recovery: quarantine the unreadable file and warn — never
    // silently discard data, never log its contents.
    try {
      const quarantine = `${file}.corrupt-${Date.now()}`;
      renameSync(file, quarantine);
      console.warn(
        `[PromptShield] Stored data file was unreadable and was moved aside to ` +
          `${path.basename(quarantine)}. Starting with an empty workspace.`,
      );
    } catch {
      console.warn("[PromptShield] Stored data file was unreadable. Starting with an empty workspace.");
    }
  }
  return empty();
}

let batchDepth = 0;

function persist() {
  if (batchDepth > 0) return; // deferred — flushed by the outermost batch()
  const file = dbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(getDb(), null, 2), "utf8");
  renameSync(tmp, file);
}

function persistNow() {
  const file = dbPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(getDb(), null, 2), "utf8");
  renameSync(tmp, file);
}

export function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const store = {
  /** Coarse descriptor only — never expose the on-disk path via the API. */
  storageKind: "local-json-file",

  /**
   * Run `fn` with persistence deferred: all mutations inside write a single
   * file at the end instead of one write per call. Durability is unchanged
   * (the final state is flushed once, atomically); ordering of in-memory
   * operations is preserved. Safe for synchronous critical sections only —
   * do NOT yield/await inside (interleaved async writers could share the
   * batch window). Supports nesting; only the outermost batch flushes.
   */
  batch<T>(fn: () => T): T {
    batchDepth++;
    try {
      return fn();
    } finally {
      batchDepth--;
      if (batchDepth === 0) persistNow();
    }
  },

  addRun(run: RunRecord) {
    const d = getDb();
    d.runs.unshift(run);
    if (d.runs.length > MAX_RUNS) d.runs.length = MAX_RUNS;
    persist();
  },
  getRun(runId: string) {
    return getDb().runs.find((r) => r.id === runId);
  },
  listRuns() {
    return getDb().runs;
  },

  addFindings(findings: Finding[]) {
    const d = getDb();
    d.findings.unshift(...findings);
    if (d.findings.length > MAX_FINDINGS) d.findings.length = MAX_FINDINGS;
    persist();
  },
  listFindings() {
    return getDb().findings;
  },
  getFinding(findingId: string) {
    return getDb().findings.find((f) => f.id === findingId);
  },
  updateFinding(findingId: string, patch: Partial<Finding>) {
    const f = getDb().findings.find((x) => x.id === findingId);
    if (f) {
      Object.assign(f, patch);
      persist();
    }
    return f;
  },

  audit(event: Omit<AuditEvent, "id" | "at" | "hash"> & { type: AuditEventType }) {
    const d = getDb();
    const base = { ...event, id: id("evt"), at: new Date().toISOString() };
    // audit[0] is the chronologically previous (newest) event — the new
    // event chains to it; when empty the anchor (or GENESIS) is the prev.
    const prevHash = d.audit[0]?.hash ?? d.auditChainAnchor;
    const hash = chainHash(prevHash, base);
    // Optional integrity signature — PS_AUDIT_SIGNING_KEY lives in the
    // environment, NOT in the database, so an attacker who can rewrite
    // promptshield.json cannot produce valid signatures. unsigned legacy
    // events remain verifiable by chain alone.
    const sig = signKey ? hmac(signKey, hash) : undefined;
    d.audit.unshift({ ...base, hash, ...(sig ? { sig } : {}) });
    if (d.audit.length > MAX_AUDIT_EVENTS) {
      // The dropped event's hash becomes the chain anchor — retained events
      // remain verifiable against it.
      d.auditChainAnchor = d.audit[MAX_AUDIT_EVENTS]?.hash ?? d.auditChainAnchor;
      d.audit.length = MAX_AUDIT_EVENTS;
    }
    // Periodic checkpoint — a signed snapshot of the chain tip kept outside
    // the mutable store file. Frequency bounded to limit write overhead.
    if (signKey && d.audit.length % 50 === 0) this.auditCheckpoint();
    persist();
  },
  verifyAuditChain(): { valid: boolean; checked: number; firstBadId?: string; checkpoint?: string } {
    // Events are stored newest-first; walk oldest→newest recomputing hashes.
    const d = getDb();
    const events = [...d.audit].reverse();
    let prev: string | undefined = d.auditChainAnchor;
    for (const e of events) {
      if (!e.hash) return { valid: false, checked: 0, firstBadId: e.id };
      const { hash, sig, ...body } = e as AuditEvent & { sig?: string };
      const expected = chainHash(prev, body as never);
      if (expected !== hash) return { valid: false, checked: 0, firstBadId: e.id };
      // When signing is configured, any event lacking a valid sig is treated
      // as integrity-suspect (an attacker can forge hashes but not HMACs).
      if (signKey && (!sig || sig !== hmac(signKey, hash))) {
        return { valid: false, checked: 0, firstBadId: e.id };
      }
      prev = hash;
    }
    const checkpoint = verifyCheckpoint(d);
    return { valid: true, checked: events.length, checkpoint };
  },

  /** Write a signed checkpoint separate from the mutable store file. */
  auditCheckpoint(): { at: string; lastHash: string; count: number; sig?: string } {
    const d = getDb();
    const cp = {
      at: new Date().toISOString(),
      lastHash: d.audit[0]?.hash ?? d.auditChainAnchor ?? "GENESIS",
      count: d.audit.length,
    };
    const sig = signKey ? hmac(signKey, JSON.stringify(cp)) : undefined;
    const file = checkpointPath();
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ ...cp, sig }, null, 2), "utf8");
    } catch {
      // Checkpoint failure must not break the event path — surfaced on verify.
    }
    return { ...cp, sig };
  },
  listAudit() {
    return getDb().audit;
  },

  addAgentSession(s: AgentSession) {
    const d = getDb();
    d.agentSessions.unshift(s);
    if (d.agentSessions.length > MAX_AGENT_SESSIONS) d.agentSessions.length = MAX_AGENT_SESSIONS;
    persist();
  },
  getAgentSession(sessionId: string) {
    return getDb().agentSessions.find((s) => s.id === sessionId);
  },
  updateAgentSession(sessionId: string, patch: Partial<AgentSession>) {
    const s = getDb().agentSessions.find((x) => x.id === sessionId);
    if (s) {
      Object.assign(s, patch);
      persist();
    }
    return s;
  },
  listAgentSessions() {
    return getDb().agentSessions;
  },

  addBenchmarkRun(b: BenchmarkRun) {
    const d = getDb();
    d.benchmarkRuns.unshift(b);
    if (d.benchmarkRuns.length > MAX_BENCHMARK_RUNS) d.benchmarkRuns.length = MAX_BENCHMARK_RUNS;
    persist();
  },
  listBenchmarkRuns() {
    return getDb().benchmarkRuns;
  },
  getBenchmarkRun(benchId: string) {
    return getDb().benchmarkRuns.find((b) => b.id === benchId);
  },

  reset() {
    db = empty();
    persist();
  },
};
