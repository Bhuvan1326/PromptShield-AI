import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent, AuditEventType, Finding, RunRecord } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.join(__dirname, "data");

// Bounded retention keeps the JSON file and memory footprint flat during
// long demo sessions. Oldest entries are evicted; findings retain their own
// evidence snapshot so eviction of the parent run does not corrupt them.
const MAX_RUNS = 200;
const MAX_FINDINGS = 500;
const MAX_AUDIT_EVENTS = 500;

interface Db {
  runs: RunRecord[];
  findings: Finding[];
  audit: AuditEvent[];
}

const empty = (): Db => ({ runs: [], findings: [], audit: [] });

function dbPath(): string {
  return process.env.PROMPTSHIELD_DB_PATH || path.join(DEFAULT_DATA_DIR, "promptshield.json");
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
      return {
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      };
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

function persist() {
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

  audit(event: Omit<AuditEvent, "id" | "at"> & { type: AuditEventType }) {
    getDb().audit.unshift({ ...event, id: id("evt"), at: new Date().toISOString() });
    // Cap the log so the file stays bounded during a demo.
    if (getDb().audit.length > MAX_AUDIT_EVENTS) getDb().audit.length = MAX_AUDIT_EVENTS;
    persist();
  },
  listAudit() {
    return getDb().audit;
  },

  reset() {
    db = empty();
    persist();
  },
};
