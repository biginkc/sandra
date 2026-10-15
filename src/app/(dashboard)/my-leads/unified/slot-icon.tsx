import { AlertTriangle, Droplet, DropletOff, MessageSquare, Sparkles } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SlotIcon, WorkFacts } from "./contract";

/**
 * The five-state slot icon left of the name, in the design's priority order (v8 section 4):
 * new reply not answered > something broke > new lead, never called > in a drip (healthy) > not in a drip.
 * A contact-only inbound (attribution unclear) is not a New reply, so it does not take the first slot.
 */
export function slotIconFor(
  facts: Pick<WorkFacts, "latestInbound" | "broken" | "stage" | "attemptsCount" | "drip" | "labels">,
): SlotIcon {
  const inbound = facts.latestInbound;
  if (inbound && !inbound.handled && !inbound.contactOnly) return "new_reply";
  if (facts.broken.length > 0 || facts.labels.includes("broken")) return "broken";
  // Unclear attribution keeps the not-in-a-drip icon (the row's "check texts" label carries the rest).
  if (inbound?.contactOnly && !inbound.handled) return "no_drip";
  if (facts.stage === "not_contacted" && facts.attemptsCount === 0) return "new_lead";
  if (facts.drip?.healthy) return "in_drip";
  return "no_drip";
}

const ICON_META: Record<SlotIcon, { label: string; Icon: typeof Droplet; className: string }> = {
  new_reply: { label: "New reply not answered", Icon: MessageSquare, className: "text-blue-600 dark:text-blue-400" },
  broken: { label: "Something broke", Icon: AlertTriangle, className: "text-red-600 dark:text-red-400" },
  new_lead: { label: "New lead, never called", Icon: Sparkles, className: "text-amber-600 dark:text-amber-400" },
  in_drip: { label: "In a drip", Icon: Droplet, className: "text-cyan-700 dark:text-cyan-400" },
  no_drip: { label: "Not in a drip", Icon: DropletOff, className: "text-muted-foreground" },
};

export const SLOT_ICON_LABELS: Record<SlotIcon, string> = {
  new_reply: ICON_META.new_reply.label,
  broken: ICON_META.broken.label,
  new_lead: ICON_META.new_lead.label,
  in_drip: ICON_META.in_drip.label,
  no_drip: ICON_META.no_drip.label,
};

export type SlotIconViewProps = {
  icon: SlotIcon;
  className?: string;
};

/** Renders one slot icon with an accessible name (role img). */
export function SlotIconView({ icon, className }: SlotIconViewProps) {
  const { label, Icon, className: tone } = ICON_META[icon];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-slot-icon={icon}
      className={cn("inline-flex size-5 shrink-0 items-center justify-center", tone, className)}
    >
      <Icon className="size-[18px]" aria-hidden="true" />
    </span>
  );
}
