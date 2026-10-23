import { clsx } from "clsx";
import type { ReactNode } from "react";
import type {
  Verdict,
  FindingSeverity,
  FindingStatus,
  Environment,
  GroundTruthLabel,
} from "@shared/types";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-lg border border-border bg-surface", className)}>
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
    <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-border">
      <div>
        <h2 className="text-xs font-semibold tracking-wide text-foreground">{title}</h2>
        {subtitle && <p className="mt-0.5 text-2xs text-muted">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}

export function MetricBlock({
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
    <div className="rounded-md border border-border bg-surface px-3.5 py-3">
      <div className="text-2xs font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={clsx("mt-1 text-xl font-semibold tabular-nums leading-none", tones[tone])}>
        {value}
      </div>
      {hint && <div className="mt-1.5 text-2xs leading-snug text-muted/80">{hint}</div>}
    </div>
  );
}

const chip =
  "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wider";

const verdictStyles: Record<Verdict, string> = {
  pass: "bg-success/10 text-success border-success/30",
  fail: "bg-danger/10 text-danger border-danger/30",
  inconclusive: "bg-warning/10 text-warning border-warning/30",
  error: "bg-muted/10 text-muted border-muted/30",
};

export function VerdictBadge({ verdict }: { verdict: Verdict }) {
  return <span className={clsx(chip, "font-semibold", verdictStyles[verdict])}>{verdict}</span>;
}

const severityStyles: Record<FindingSeverity, string> = {
  critical: "bg-danger/10 text-danger border-danger/30",
  high: "bg-warning/10 text-warning border-warning/30",
  medium: "bg-indigo/10 text-indigo border-indigo/30",
  low: "bg-muted/10 text-muted border-muted/30",
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <span className={clsx(chip, severityStyles[severity])}>{severity}</span>;
}

export function StatusBadge({ status }: { status: FindingStatus }) {
  const styles: Record<FindingStatus, string> = {
    open: "bg-danger/10 text-danger border-danger/30",
    acknowledged: "bg-warning/10 text-warning border-warning/30",
    resolved: "bg-success/10 text-success border-success/30",
  };
  return <span className={clsx(chip, styles[status])}>{status}</span>;
}

export function EnvBadge({ environment }: { environment: Environment }) {
  return (
    <span
      className={clsx(
        chip,
        "font-mono normal-case",
        environment === "baseline"
          ? "bg-danger/10 text-danger border-danger/30"
          : "bg-accent/10 text-accent border-accent/30",
      )}
    >
      {environment}
    </span>
  );
}

export function LabelBadge({ label }: { label: GroundTruthLabel }) {
  const styles: Record<GroundTruthLabel, string> = {
    attack: "bg-danger/10 text-danger border-danger/30",
    benign: "bg-success/10 text-success border-success/30",
    invalid: "bg-muted/10 text-muted border-muted/30",
  };
  return <span className={clsx(chip, styles[label])}>{label}</span>;
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border bg-card px-1.5 py-0.5 text-2xs text-muted">
      {children}
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
      "bg-accent/10 text-accent border border-accent/40 hover:bg-accent/15 hover:border-accent/60",
    ghost:
      "bg-transparent text-muted border border-border hover:text-foreground hover:border-muted/50",
    danger: "bg-transparent text-danger border border-danger/30 hover:bg-danger/10",
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-40",
        styles[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-card p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            "rounded px-2.5 py-1 text-xs font-medium transition-colors",
            value === o.value ? "bg-surface text-foreground" : "text-muted hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border py-14 text-center">
      <p className="text-sm font-medium text-foreground/80">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span className="h-3 w-3 animate-spin rounded-full border border-accent/40 border-t-accent" />
      {label}
    </span>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
      {message}
    </div>
  );
}

export function MonoBlock({
  label,
  content,
  className,
}: {
  label?: string;
  content: string;
  className?: string;
}) {
  return (
    <div className={className}>
      {label && (
        <div className="mb-1 text-2xs font-medium uppercase tracking-wider text-muted">{label}</div>
      )}
      <pre className="whitespace-pre-wrap break-words rounded-md border border-border bg-card px-3 py-2 font-mono text-2xs leading-relaxed text-foreground/90">
        {content}
      </pre>
    </div>
  );
}
