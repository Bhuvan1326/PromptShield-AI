import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditEvent, AuditEventType, Finding, RunRecord } from "../shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "promptshield.json");

interface Db {
  runs: RunRecord[];
  findings: Finding[];
  audit: AuditEvent[];
}

const empty: Db = { runs: [], findings: [], audit: [] };

let db: Db = load();

function load(): Db {
  try {
    if (existsSync(DB_PATH)) {
      const parsed = JSON.parse(readFileSync(DB_PATH, "utf8")) as Partial<Db>;
      return {
        runs: Array.isArray(parsed.runs) ? parsed.runs : [],
        findings: Array.isArray(parsed.findings) ? parsed.findings : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit : [],
      };
    }
  } catch {
    // Corrupt store: start clean rather than crash the demo.
  }
  return { ...empty };
}

function persist() {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
  renameSync(tmp, DB_PATH);
}

export function id(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const store = {
  dataPath: DB_PATH,

  addRun(run: RunRecord) {
    db.runs.unshift(run);
    persist();
  },
  getRun(id: string) {
    return db.runs.find((r) => r.id === id);
  },
  listRuns() {
    return db.runs;
  },

  addFindings(findings: Finding[]) {
    db.findings.unshift(...findings);
    persist();
  },
  listFindings() {
    return db.findings;
  },
  getFinding(id: string) {
    return db.findings.find((f) => f.id === id);
  },
  updateFinding(id: string, patch: Partial<Finding>) {
    const f = db.findings.find((x) => x.id === id);
    if (f) {
      Object.assign(f, patch);
      persist();
    }
    return f;
  },

  audit(event: Omit<AuditEvent, "id" | "at"> & { type: AuditEventType }) {
    db.audit.unshift({ ...event, id: id("evt"), at: new Date().toISOString() });
    // Cap the log so the file stays bounded during a demo.
    if (db.audit.length > 500) db.audit.length = 500;
    persist();
  },
  listAudit() {
    return db.audit;
  },

  reset() {
    db = { ...empty };
    persist();
  },
};
