"use client";

import { SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { callAction } from "@/lib/errors/call-action";
import { formatPhoneE164 } from "@/lib/phone-format";
import { renderTemplate } from "@/lib/templates/render";
import { type TemplateRow } from "@/app/(dashboard)/templates/actions";
import { TemplatePicker } from "@/app/(dashboard)/templates/template-picker";

import { sendSmsFromLead, loadLeadVars } from "../actions";

type Props = {
  propertyId: string;
  /** Falsy when the lead has no homeowner contact yet — disables the box. */
  homeownerContactId: string | null;
  /** Falsy when the homeowner has no usable SMS phone — disables + explains. */
  homeownerPhone: string | null;
  /** Optional saved contact phone that matches the open Messages thread. */
  replyToPhone?: string | null;
  preferredFromNumber?: string | null;
  phoneUnavailableMessage?: string;
};

/**
 * Inline reply box under the SMS thread. Queues via the existing
 * `sendSmsFromLead` server action — same TCPA + quiet-hours guardrails
 * as the modal composer. Kept intentionally minimal: no from-number
 * picker here; it replies from the business number the seller most
 * recently texted. The modal composer handles explicit sender changes.
 */
export function InlineReply({
  propertyId,
  homeownerContactId,
  homeownerPhone,
  replyToPhone = null,
  preferredFromNumber = null,
  phoneUnavailableMessage,
}: Props) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  // Tracks the most recent template selection so a slower in-flight
  // `loadLeadVars` for an earlier click can't overwrite the body the user
  // just picked (WR-04). Hooks must run before the early-return for the
  // disabled state, so this lives at the top of the component body.
  const templateRequestToken = useRef(0);
  const fromNumber = preferredFromNumber;

  const disabled = !homeownerContactId || !homeownerPhone;
  const disabledReason = !homeownerContactId
    ? "No homeowner contact on this lead — can't reply yet."
    : !homeownerPhone
      ? (phoneUnavailableMessage ??
        "Homeowner has no phone number — add one before replying.")
      : null;

  const length = body.length;
  const tooLong = length > 1600;
  const canSend = !disabled && length > 0 && !tooLong && !pending;
  const effectiveToPhone = replyToPhone ?? homeownerPhone;

  const send = () => {
    if (!canSend) return;
    startTransition(async () => {
      const result = await callAction(
        sendSmsFromLead(propertyId, body, fromNumber, true, effectiveToPhone),
        { fallbackMessage: "SMS queue failed" },
      );
      if (!result.ok) return;

      const { outcome } = result.data;
      switch (outcome.status) {
        case "sent":
          // queueOnly=true makes this an invalid action contract. Keep the
          // branch fail-closed in case a server regression returns it.
          toast.error("Queue confirmation failed", {
            description:
              "The server reported an immediate send. Refresh before retrying.",
          });
          break;
        case "queued":
          toast.success("Added to Outbox", {
            description: `Queued for ${effectiveToPhone}. Review delivery in Outbox.`,
          });
          setBody("");
          router.refresh();
          break;
        case "blocked_no_consent":
          toast.error("Blocked: no consent", { description: outcome.reason });
          break;
        case "blocked_quiet_hours":
          toast.warning("Blocked: quiet hours", {
            description: outcome.reason,
          });
          break;
        case "blocked_no_phone":
          toast.error("Blocked: no phone", { description: outcome.reason });
          break;
        case "blocked_landline":
        case "blocked_terminal_dispo":
          toast.warning("Skipped", { description: outcome.reason });
          break;
        case "blocked_provider_off":
          toast.error("Messaging disabled", { description: outcome.reason });
          break;
        case "provider_failed":
          toast.error("Provider error", { description: outcome.error });
          break;
        case "contact_not_found":
        case "property_not_found":
          toast.error("Lead not found");
          break;
        case "db_error":
          toast.error("Database error", { description: outcome.error });
          break;
      }
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd/Ctrl + Enter sends — matches Slack / Linear convention.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
  };

  if (disabled) {
    return (
      <div className="border-[#e5e1df] text-[#78716c] rounded-xl border border-dashed p-3 text-center text-xs">
        {disabledReason}
      </div>
    );
  }

  const handleTemplateSelect = (template: TemplateRow) => {
    // WR-03: protect a non-empty draft from being silently clobbered.
    // VAs who click "Templates" to peek expect a confirmation, not data
    // loss. Empty draft = no prompt.
    if (
      body.trim().length > 0 &&
      !window.confirm("Replace your draft with this template?")
    ) {
      return;
    }

    const requestId = ++templateRequestToken.current;
    // Try to interpolate with lead data; fall back to raw content.
    // Stale-resolution guard (WR-04): only apply this fetch's result if
    // it's still the latest click. Two quick clicks → two in-flight
    // requests; the second click bumps the token so the first one's
    // resolution is dropped on the floor.
    loadLeadVars(propertyId).then((result) => {
      if (requestId !== templateRequestToken.current) return;
      if (result.ok) {
        setBody(renderTemplate(template.content, result.data));
      } else {
        setBody(template.content);
      }
    });
  };

  const formattedFrom = formatPhoneE164(fromNumber);
  const formattedTo = formatPhoneE164(effectiveToPhone);

  return (
    <div className="flex flex-col gap-2" data-testid="inline-reply">
      <div className="bg-[#fdfcfb] border border-[#e5e1df] rounded-xl p-4 transition-colors focus-within:border-[#111827]">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type your reply…  (⌘/Ctrl + Enter to send)"
          aria-label="Reply to this lead"
          disabled={pending}
          maxLength={2000}
          rows={2}
          className="w-full bg-transparent border-none focus:ring-0 focus:outline-none text-[14px] resize-none min-h-[60px] placeholder:text-[#a8a29e]"
        />
        <div className="flex items-center justify-between gap-3 mt-2 pt-2 border-t border-[#e5e1df]/60">
          <div className="flex items-center gap-3 text-[#78716c] min-w-0">
            <span className="text-[11px] font-medium flex items-center gap-1.5 min-w-0">
              <span className="shrink-0">From:</span>
              <span className="text-[#1c1917] font-bold tabular-nums truncate">
                {formattedFrom ?? "—"}
              </span>
            </span>
            <span className="text-[11px] font-medium flex items-center gap-1.5 min-w-0">
              <span className="shrink-0">To:</span>
              <span className="text-[#1c1917] font-bold tabular-nums truncate">
                {formattedTo ?? "—"}
              </span>
            </span>
            <TemplatePicker onSelect={handleTemplateSelect} />
            <span
              className={`shrink-0 text-[10px] tabular-nums ${
                tooLong ? "text-red-600" : "text-[#a8a29e]"
              }`}
            >
              {length} / 1600
            </span>
          </div>
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            aria-label="Queue reply in Outbox"
            data-testid="inline-reply-send"
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full bg-primary px-5 py-2 text-[12px] font-bold text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Queueing…" : "Queue SMS"}
            <SendIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="text-[10px] text-center text-[#a8a29e] px-2">
        This adds the message to Outbox. Delivery happens only after the queue
        re-checks consent, suppression, and release timing.
      </p>
    </div>
  );
}
