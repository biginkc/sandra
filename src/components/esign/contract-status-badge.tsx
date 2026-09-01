import { Badge } from "@/components/ui/badge";
import type { ContractStatus } from "@/lib/esign/contract-status";
import { cn } from "@/lib/utils";

const CONTRACT_STATUS_DISPLAY = {
  awaiting: {
    label: "Awaiting",
    className:
      "border-status-replying-border bg-status-replying-bg text-status-replying-fg",
    dotClassName: "bg-status-replying-fg",
  },
  viewed: {
    label: "Viewed",
    className: "border-status-new-border bg-status-new-bg text-status-new-fg",
    dotClassName: "bg-status-new-fg",
  },
  signed: {
    label: "Signed",
    className:
      "border-alert-healthy/30 bg-alert-healthy/10 text-alert-healthy",
    dotClassName: "bg-alert-healthy",
  },
  declined: {
    label: "Declined",
    className: "border-status-hot-border bg-status-hot-bg text-status-hot-fg",
    dotClassName: "bg-status-hot-fg",
  },
  voided: {
    label: "Voided",
    className:
      "border-status-contacted-border bg-status-contacted-bg text-status-contacted-fg",
    dotClassName: "bg-status-contacted-fg",
  },
  error: {
    label: "Error",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
    dotClassName: "bg-destructive",
  },
} as const satisfies Record<
  ContractStatus,
  { label: string; className: string; dotClassName: string }
>;

const CONTRACT_BADGE_VARIANT = "outline" as const;

export interface ContractStatusBadgeProps {
  status?: ContractStatus | null;
}

export function ContractStatusBadge({
  status,
}: ContractStatusBadgeProps) {
  if (!status) return null;

  const display = CONTRACT_STATUS_DISPLAY[status];

  return (
    <Badge
      variant={CONTRACT_BADGE_VARIANT}
      data-contract-variant={CONTRACT_BADGE_VARIANT}
      data-testid="contract-status-badge"
      data-status={status}
      className={cn("gap-1 text-[10px]", display.className)}
    >
      <span
        aria-hidden="true"
        data-testid="contract-status-dot"
        className={cn("size-1.5 shrink-0 rounded-full", display.dotClassName)}
      />
      {display.label}
    </Badge>
  );
}
