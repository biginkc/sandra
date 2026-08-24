"use client";

import { PhoneIcon } from "lucide-react";

import { useOptionalSoftphone, type SoftphoneLead } from "./softphone-provider";

type Props = {
  lead: SoftphoneLead;
  compact?: boolean;
};

export function SoftphoneLeadButton({ lead, compact = false }: Props) {
  const context = useOptionalSoftphone();
  if (!context) return null;
  const { openLead, callingEnabled } = context;
  if (!lead.callable) return null;
  return (
    <button
      type="button"
      data-testid="call-lead-button"
      aria-label={`Call ${lead.firstName} now — 1 click`}
      title={
        callingEnabled
          ? `Call ${lead.firstName} now — 1 click`
          : "Calling not yet enabled"
      }
      disabled={!callingEnabled}
      className={
        compact
          ? "border-border text-muted-foreground hover:border-emerald-600 hover:bg-emerald-600 hover:text-white flex size-9 shrink-0 items-center justify-center rounded-full border bg-white transition-colors"
          : "border-border text-muted-foreground hover:border-emerald-600 hover:bg-emerald-600 hover:text-white inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-xs font-bold transition-colors"
      }
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        if (callingEnabled) openLead(lead);
      }}
    >
      <PhoneIcon className={compact ? "size-3.5" : "size-3.5"} />
      {!compact ? "Call" : null}
    </button>
  );
}
