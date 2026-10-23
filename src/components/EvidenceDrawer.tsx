import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { clsx } from "clsx";
import type { EvidenceItem, ExecutionResult, TestCase } from "@shared/types";
import { EnvBadge, LabelBadge, VerdictBadge } from "./ui";
import { fmtMs } from "../lib/format";

const kindStyles: Record<EvidenceItem["kind"], string> = {
  prompt: "border-indigo/30 bg-indigo/5",
  response: "border-border bg-surface",
  defense_decision: "border-accent/30 bg-accent/5",
  canary_check: "border-warning/30 bg-warning/5",
  action_check: "border-warning/30 bg-warning/5",
  note: "border-border bg-surface/60",
};

export function EvidenceDrawer({
  result,
  test,
  environment,
  open,
  onClose,
}: {
  result: ExecutionResult | null;
  test: TestCase | null;
  environment: "baseline" | "defended";
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-background shadow-2xl focus:outline-none">
          <div className="flex items-start justify-between border-b border-border px-5 py-4">
            <div>
              <Dialog.Title className="text-sm font-semibold">
                {test ? test.title : result?.testId}
              </Dialog.Title>
              <div className="mt-1.5 flex items-center gap-2">
                {result && <VerdictBadge verdict={result.verdict} />}
                <EnvBadge environment={environment} />
                {test && <LabelBadge label={test.label} />}
                {result && (
                  <span className="text-[11px] text-muted">{fmtMs(result.durationMs)}</span>
                )}
              </div>
            </div>
            <Dialog.Close className="rounded p-1 text-muted hover:text-foreground">
              <X size={16} />
            </Dialog.Close>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {test && (
              <div className="rounded-md border border-border bg-surface/60 p-3 text-xs text-muted">
                <span className="font-medium text-foreground">Expectation: </span>
                {test.expectation.description}
              </div>
            )}
            {result?.errorMessage && (
              <div className="rounded-md border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
                {result.errorMessage}
              </div>
            )}
            {result?.evidence.map((e, i) => (
              <div key={i} className={clsx("rounded-md border p-3", kindStyles[e.kind])}>
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
                  {e.label}
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
                  {e.content}
                </pre>
              </div>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
