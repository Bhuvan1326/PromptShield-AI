import { clsx } from "clsx";
import type { ReactNode } from "react";
import type { Verdict, FindingSeverity, FindingStatus, Environment, GroundTruthLabel } from "@shared/types";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-lg border border-border bg-card p-5 shadow-card", className)}>
      {children}
    </div>
  );
}

export function SectionTitle({
  title,
  subtitle,
  right,
}: {
  title: string;
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-foreground">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "danger" | "warning" | "accent";
}) {
  const tones = {
    default: "text-foreground",
    success: "text-success",
    danger: "text-danger",
    warning: "text-warning",
    accent: "text-accent",
  };
  return (
    <Card className="p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={clsx("mt-1.5 text-2xl font-semibold tabular-nums", tones[tone])}>{value}</div>
      {hint && <div className="mt-1 text-[11px] leading-snug text-muted">{hint}</div>}
    </Card>
  );
}

const verdictStyles: Record<Verdict, string> = {
  pass: "bg-success/15 text-success border-success/30",
  fail: "bg-danger/15 text-danger border-danger/30",
  inconclusive: "bg-warning/15 text-warning border-warning/30",
  error: "bg-muted/15 text-muted border-muted/30",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        verdictStyles[verdict],
      )}
    >
      {verdict}
    </span>
  );
}

const severityStyles: Record<FindingSeverity, string> = {
  critical: "bg-danger/15 text-danger border-danger/30",
  high: "bg-orange-400/15 text-orange-300 border-orange-400/30",
  medium: "bg-warning/15 text-warning border-warning/30",
  low: "bg-indigo/15 text-indigo border-indigo/30",
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        severityStyles[severity],
      )}
    >
      {severity}
    </span>
  );
}

export function StatusBadge({ status }: { status: FindingStatus }) {
  const styles: Record<FindingStatus, string> = {
    open: "bg-danger/10 text-danger border-danger/25",
    acknowledged: "bg-warning/10 text-warning border-warning/25",
    resolved: "bg-success/10 text-success border-success/25",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        styles[status],
      )}
    >
      {status}
    </span>
  );
}

export function EnvBadge({ environment }: { environment: Environment }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
        environment === "baseline"
          ? "bg-danger/10 text-danger border-danger/25"
          : "bg-accent/10 text-accent border-accent/25",
      )}
    >
      {environment}
    </span>
  );
}

export function LabelBadge({ label }: { label: GroundTruthLabel }) {
  const styles: Record<GroundTruthLabel, string> = {
    attack: "bg-danger/10 text-danger border-danger/25",
    benign: "bg-success/10 text-success border-success/25",
    invalid: "bg-muted/10 text-muted border-muted/25",
  };
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        styles[label],
      )}
    >
      {label}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  const styles = {
    primary:
      "bg-accent/15 text-accent border border-accent/40 hover:bg-accent/25 disabled:opacity-40",
    ghost: "bg-surface text-muted border border-border hover:text-foreground hover:border-muted/50 disabled:opacity-40",
    danger: "bg-danger/10 text-danger border border-danger/30 hover:bg-danger/20 disabled:opacity-40",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        styles[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-12 text-center">
      <p className="text-sm font-medium text-muted">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs text-muted/70">{hint}</p>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
      {label ?? "Loading…"}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
      {message}
    </div>
  );
}
