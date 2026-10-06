"use client";

import { PhoneIcon } from "lucide-react";

import { useOptionalDialpadCall } from "@/components/dialpad/dialpad-call-context";
import { useOptionalSoftphone, type SoftphoneLead } from "./softphone-provider";

type Props = {
  lead: SoftphoneLead;
  compact?: boolean;
};

export function SoftphoneLeadButton({ lead, compact = false }: Props) {
  const context = useOptionalSoftphone();
  const dialpad = useOptionalDialpadCall();
  // Dialpad only when the server-derived route says so and the lead has a contact to dial; otherwise today's softphone path.
  const viaDialpad = Boolean(dialpad?.enabled && lead.contactId);
  if (!context && !viaDialpad) return null;
  const openLead = (target: SoftphoneLead) => context?.openLead(target);
  const callingEnabled = viaDialpad || Boolean(context?.callingEnabled);
  if (!lead.callable) return null;
  const button = (
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
        if (viaDialpad && dialpad && lead.contactId) {
          dialpad.startCall({
            propertyId: lead.id,
            contactId: lead.contactId,
            label: lead.name,
            // Not configured on the server after all: the legacy softphone, exactly as before.
            onFallback: () => {
              if (context?.callingEnabled) openLead(lead);
            },
          });
          return;
        }
        if (callingEnabled) openLead(lead);
      }}
    >
      <PhoneIcon className={compact ? "size-3.5" : "size-3.5"} />
      {!compact ? "Call" : null}
    </button>
  );
  if (!viaDialpad) return button;
  // Dialpad is the default; the softphone stays one click away so live coaching still works.
  return (
    <>
      {button}
      <button
        type="button"
        data-testid="call-with-coach-button"
        disabled={!context?.callingEnabled}
        className="border-border text-muted-foreground hover:border-emerald-600 hover:text-emerald-700 inline-flex shrink-0 items-center rounded-full border bg-white px-2 py-1 text-[11px] font-semibold transition-colors disabled:opacity-50"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          if (context?.callingEnabled) openLead(lead);
        }}
      >
        Call with coach
      </button>
    </>
  );
}
