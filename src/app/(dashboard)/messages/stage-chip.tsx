import { StatusChip, type StatusVariant } from "@/components/ui/status-chip";

const PROPERTY_STAGE: Record<
  string,
  { label: string; variant: StatusVariant }
> = {
  prospect: { label: "Prospect", variant: "new" },
  new_lead: { label: "New Lead", variant: "new" },
  contacted: { label: "Contacted", variant: "contacted" },
  interested: { label: "Interested", variant: "hot" },
  offer_sent: { label: "Offer Sent", variant: "replying" },
  offer_declined: { label: "Offer Declined", variant: "cold" },
  under_contract: { label: "Under Contract", variant: "hot" },
  closed: { label: "Closed", variant: "contacted" },
  dead: { label: "Dead", variant: "dead" },
};

export function MessageStageChip({
  status,
  historical = false,
  compact = false,
}: {
  status: string | null;
  historical?: boolean;
  compact?: boolean;
}) {
  if (!status) return null;

  const stage = PROPERTY_STAGE[status] ?? {
    label: status.replaceAll("_", " "),
    variant: "contacted" as const,
  };
  const label = historical ? `Historical · ${stage.label}` : stage.label;

  return (
    <StatusChip
      status={stage.variant}
      label={label}
      data-testid="message-stage-chip"
      className={
        compact
          ? "px-2 py-0.5 text-[9px] leading-none"
          : "px-3 py-1 text-[10px]"
      }
    />
  );
}
