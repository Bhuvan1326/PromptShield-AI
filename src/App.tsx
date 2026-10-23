import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import {
  ClipboardList,
  FlaskConical,
  Gauge,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import { api, type Catalog } from "./lib/api";
import type { Environment, IntegrationStatus } from "@shared/types";
import Overview from "./views/Overview";
import TestLab from "./views/TestLab";
import Findings from "./views/Findings";
import Evaluation from "./views/Evaluation";
import Audit from "./views/Audit";
import { EnvBadge, Spinner } from "./components/ui";

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
  environment: Environment;
  setEnvironment: Dispatch<SetStateAction<Environment>>;
  refreshSignal: number;
  triggerRefresh: () => void;
}

const PAGE_TITLES: Record<string, string> = {
  "/": "Overview",
  "/lab": "Test Lab",
  "/findings": "Findings",
  "/evaluation": "Evaluation",
  "/audit": "Audit",
};

export default function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [environment, setEnvironment] = useState<Environment>("baseline");
  const [error, setError] = useState<string | null>(null);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const location = useLocation();

  useEffect(() => {
    Promise.all([api.catalog(), api.status()])
      .then(([c, s]) => {
        setCatalog(c);
        setStatus(s);
      })
      .catch((e) => setError(e.message));
  }, []);

  const ctx: AppContext | null = catalog
    ? {
        catalog,
        status,
        environment,
        setEnvironment,
        refreshSignal,
        triggerRefresh: () => setRefreshSignal((n) => n + 1),
      }
    : null;

  const apiUp = !error && catalog !== null;

  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:border focus:border-accent/50 focus:bg-surface focus:px-3 focus:py-2 focus:text-xs focus:text-accent"
      >
        Skip to main content
      </a>
      {/* Left navigation — 220px engineering rail */}
      <aside className="fixed inset-y-0 left-0 z-30 flex w-[220px] flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2">
            <ShieldCheck size={15} className="text-accent" strokeWidth={2} />
            <span className="text-[13px] font-semibold tracking-tight">PromptShield AI</span>
          </div>
          <p className="mt-0.5 text-2xs text-muted">Security test workbench</p>
        </div>
        <nav className="flex-1 space-y-px px-2 py-3">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-card text-foreground"
                    : "text-muted hover:bg-card/60 hover:text-foreground"
                }`
              }
            >
              {({ isActive }) => (
                <>
                  <Icon size={14} strokeWidth={1.75} className={isActive ? "text-accent" : ""} />
                  {label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-border px-4 py-3">
          <div className="space-y-1.5 text-2xs text-muted">
            <div className="flex items-center justify-between">
              <span>API</span>
              <span className="flex items-center gap-1.5">
                <span className={`h-1.5 w-1.5 rounded-full ${apiUp ? "bg-success" : "bg-danger"}`} />
                {apiUp ? "connected" : "offline"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Gemini</span>
              <span className="flex items-center gap-1.5">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    status?.gemini.state === "configured" ? "bg-success" : "bg-muted/40"
                  }`}
                />
                {status?.gemini.state === "configured" ? status.gemini.model : "not configured"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span>Engine</span>
              <span>{status ? `${status.engine.testCases} fixtures` : "—"}</span>
            </div>
          </div>
          <p className="mt-3 border-t border-border/60 pt-2 text-2xs leading-snug text-muted/60">
            Simulation harness · synthetic data only
          </p>
        </div>
      </aside>

      <div className="ml-[220px] flex min-h-screen flex-1 flex-col">
        {/* Compact header */}
        <header className="sticky top-0 z-20 flex h-11 items-center justify-between border-b border-border bg-background/95 px-5 backdrop-blur-sm">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted">PromptShield</span>
            <span className="text-muted/50">/</span>
            <span className="font-medium text-foreground">
              {PAGE_TITLES[location.pathname] ?? "Overview"}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-2xs text-muted">Environment</span>
            <EnvBadge environment={environment} />
            <span className="hidden text-2xs text-muted sm:inline">
              simulated harness · no live targets
            </span>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 px-5 py-5">
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
    </div>
  );
}
