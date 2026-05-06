// StatusChip — BMH 6-hue semantic status pill.
//
// Source: Stitch wholesale_real_estate_crm leads pipeline mockup.
// Used in: Sandra CRM (lead status), Sandra Practice (score chips, mapped
// from rubric percentages), Sandra University (lesson completion states).
//
// Depends on: @sandra/tokens for the --status-* CSS variables. Consumes the
// `bg-status-{state}-{bg,fg,border}` Tailwind utilities exposed via
// @theme inline in tokens/theme.css.
//
// The chip is fully pill (rounded-full), text-[11px] font-black uppercase
// tracking-tighter, px-4 py-1 — these are not configurable by design.
// State-specific styling is the only variant.

import { cn } from "@/lib/utils";

const STATUS_VARIANTS = {
  replying:
    "bg-status-replying-bg text-status-replying-fg border-status-replying-border",
  hot: "bg-status-hot-bg text-status-hot-fg border-status-hot-border",
  new: "bg-status-new-bg text-status-new-fg border-status-new-border",
  contacted:
    "bg-status-contacted-bg text-status-contacted-fg border-status-contacted-border",
  cold: "bg-status-cold-bg text-status-cold-fg border-status-cold-border",
  dead: "bg-status-dead-bg text-status-dead-fg border-status-dead-border",
} as const;

const STATUS_LABELS = {
  replying: "Replying",
  hot: "Hot",
  new: "New",
  contacted: "Contacted",
  cold: "Cold",
  dead: "Dead",
} as const;

export type StatusVariant = keyof typeof STATUS_VARIANTS;

export interface StatusChipProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  /** Semantic state. Determines color + default label. */
  status: StatusVariant;
  /** Override the default label (e.g., "Closed lost" instead of "Dead"). */
  label?: string;
}

/**
 * Status chip with the BMH 6-hue palette.
 *
 * @example
 * <StatusChip status="hot" />
 * <StatusChip status="dead" label="Closed lost" />
 *
 * For score-derived chips (Sandra Practice), bucket the score then map:
 * @example
 * function scoreToStatus(score: number): StatusVariant {
 *   if (score >= 81) return "hot";
 *   if (score >= 61) return "replying";
 *   if (score >= 41) return "contacted";
 *   if (score >= 1)  return "cold";
 *   return "dead";
 * }
 */
export function StatusChip({
  status,
  label,
  className,
  ...props
}: StatusChipProps) {
  return (
    <span
      data-slot="status-chip"
      data-status={status}
      className={cn(
        "inline-flex items-center px-4 py-1 rounded-full border",
        "text-[11px] font-black uppercase tracking-tighter whitespace-nowrap",
        STATUS_VARIANTS[status],
        className
      )}
      {...props}
    >
      {label ?? STATUS_LABELS[status]}
    </span>
  );
}
