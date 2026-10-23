import { useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import {
  ClipboardList,
  FlaskConical,
  Gauge,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { api, type Catalog } from "./lib/api";
import type { IntegrationStatus } from "@shared/types";
import Overview from "./views/Overview";
import TestLab from "./views/TestLab";
import Findings from "./views/Findings";
import Evaluation from "./views/Evaluation";
import Audit from "./views/Audit";
import { Spinner } from "./components/ui";

const NAV = [
  { to: "/", label: "Overview", icon: Gauge, end: true },
  { to: "/lab", label: "Test Lab", icon: FlaskConical },
  { to: "/findings", label: "Findings", icon: ShieldCheck },
  { to: "/evaluation", label: "Evaluation", icon: ClipboardList },
  { to: "/audit", label: "Audit", icon: ScrollText },
];

export interface AppContext {
  catalog: Catalog;
  status: IntegrationStatus | null;
  refreshSignal: number;
  triggerRefresh: () => void;
}

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);

  useEffect(() => {
    Promise.all([api.catalog(), api.status()])
      .then(([c, s]) => {
        setCatalog(c);
        setStatus(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  const ctx: AppContext | null = catalog
    ? { catalog, status, refreshSignal, triggerRefresh: () => setRefreshSignal((n) => n + 1) }
    : null;

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 flex w-56 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-5 py-5">
          <div className="flex items-center gap-2">
            <ShieldCheck size={18} className="text-accent" />
            <span className="text-sm font-bold tracking-wide">PromptShield AI</span>
          </div>
          <p className="mt-1 text-[10px] leading-snug text-muted">
            Test the attack. Measure the defense.
          </p>
        </div>
        <nav className="flex-1 space-y-0.5 px-2 py-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-3 py-2 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-accent/10 text-accent"
                    : "text-muted hover:bg-card hover:text-foreground"
                }`
              }
            >
              <Icon size={14} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-2 text-[10px] text-muted">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                status?.gemini.state === "configured" ? "bg-success" : "bg-warning"
              }`}
            />
            {status?.gemini.state === "configured"
              ? `Gemini connected · ${status.gemini.model}`
              : "Deterministic mode · Gemini not configured"}
          </div>
          <p className="mt-2 text-[9px] leading-snug text-muted/60">
            Simulation harness only — synthetic data, no real systems.
          </p>
        </div>
      </aside>

      <main className="ml-56 flex-1 px-8 py-6">
        {error && (
          <div className="mb-4 rounded-md border border-danger/30 bg-danger/10 px-4 py-3 text-xs text-danger">
            Could not reach the PromptShield API ({error}). Is the backend running on port 8787?
          </div>
        )}
        {!ctx && !error && (
          <div className="flex h-64 items-center justify-center">
            <Spinner label="Loading test catalog…" />
          </div>
        )}
        {ctx && (
          <Routes>
            <Route path="/" element={<Overview ctx={ctx} />} />
            <Route path="/lab" element={<TestLab ctx={ctx} />} />
            <Route path="/findings" element={<Findings ctx={ctx} />} />
            <Route path="/evaluation" element={<Evaluation ctx={ctx} />} />
            <Route path="/audit" element={<Audit ctx={ctx} />} />
          </Routes>
        )}
      </main>
    </div>
  );
}
