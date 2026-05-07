import { Bot } from "lucide-react";

import {
  parseEscalationReason,
  type ReasonColor,
} from "@/lib/ai-responder/format-reason";

const COLOR_CLASSES: Record<ReasonColor, string> = {
  sky: "bg-sky-100 text-sky-700 border-sky-200",
  emerald: "bg-emerald-100 text-emerald-700 border-emerald-200",
  violet: "bg-violet-100 text-violet-700 border-violet-200",
  rose: "bg-rose-100 text-rose-700 border-rose-200",
  amber: "bg-amber-100 text-amber-700 border-amber-200",
};

type Props = {
  reason: string | null | undefined;
  size?: "sm" | "md";
  className?: string;
};

export function EscalationBadge({ reason, size = "sm", className }: Props) {
  const parsed = parseEscalationReason(reason);
  if (!parsed) return null;

  const sizeCls =
    size === "sm"
      ? "h-5 px-2 text-[10px] gap-1"
      : "h-6 px-2.5 text-xs gap-1.5";
  const iconSize = size === "sm" ? "h-3 w-3" : "h-3.5 w-3.5";

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border font-medium ${COLOR_CLASSES[parsed.color]} ${sizeCls} ${className ?? ""}`}
      title={parsed.longLabel}
      data-testid="escalation-badge"
      data-color={parsed.color}
      data-gate={parsed.gate}
      data-tier={parsed.tier ?? undefined}
    >
      <Bot className={iconSize} aria-hidden data-testid="escalation-badge-icon" />
      {parsed.shortLabel}
    </span>
  );
}
