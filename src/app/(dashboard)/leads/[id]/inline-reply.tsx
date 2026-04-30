"use client";

import { SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import { renderTemplate } from "@/lib/templates/render";
import { type TemplateRow } from "@/app/(dashboard)/templates/actions";
import { TemplatePicker } from "@/app/(dashboard)/templates/template-picker";

import { listFromNumbers, sendSmsFromLead, loadLeadVars } from "../actions";

type Props = {
  propertyId: string;
  /** Falsy when the lead has no homeowner contact yet — disables the box. */
  homeownerContactId: string | null;
  /** Falsy when the homeowner has no phone_1 — disables + explains. */
  homeownerPhone: string | null;
};

/**
 * Inline reply box under the SMS thread. Sends via the existing
 * `sendSmsFromLead` server action — same TCPA + quiet-hours guardrails
 * as the modal composer. Kept intentionally minimal: no from-number
 * picker here (provider default), no "queue later" branch (that's what
 * the modal composer is for). VAs reacting to an inbound reply just
 * want to type and hit send.
 */
export function InlineReply({
  propertyId,
  homeownerContactId,
  homeownerPhone,
}: Props) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();
  // Fetch the first "sendable" Dialpad number once on mount and use it as
  // the from. Avoids the env-default-is-unassigned footgun where
  // DIALPAD_FROM_NUMBER points at a number Dialpad rejects with
  // "A user or a group or a valid from_number must be provided for the
  // sender." The modal composer picks via a dropdown; the inline reply
  // stays minimal by auto-selecting the first usable number.
  const [fromNumber, setFromNumber] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    listFromNumbers().then((result) => {
      if (cancelled || !result.ok) return;
      const sendable = result.data.find((o) => o.status !== "available");
      if (sendable) setFromNumber(sendable.number);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const disabled = !homeownerContactId || !homeownerPhone;
  const disabledReason = !homeownerContactId
    ? "No homeowner contact on this lead — can't reply yet."
    : !homeownerPhone
      ? "Homeowner has no phone number — add one before replying."
      : null;

  const length = body.length;
  const tooLong = length > 1600;
  const canSend = !disabled && length > 0 && !tooLong && !pending;

  const send = () => {
    if (!canSend) return;
    startTransition(async () => {
      const result = await callAction(
        sendSmsFromLead(propertyId, body, fromNumber, false),
        { fallbackMessage: "SMS send failed" },
      );
      if (!result.ok) return;

      const { outcome } = result.data;
      switch (outcome.status) {
        case "sent":
          toast.success("Message sent", {
            description: `Delivered to ${homeownerPhone}.`,
          });
          setBody("");
          router.refresh();
          break;
        case "queued":
          toast.success("Queued");
          setBody("");
          router.refresh();
          break;
        case "blocked_no_consent":
          toast.error("Blocked: no consent", { description: outcome.reason });
          break;
        case "blocked_quiet_hours":
          toast.warning("Blocked: quiet hours", { description: outcome.reason });
          break;
        case "blocked_no_phone":
          toast.error("Blocked: no phone", { description: outcome.reason });
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
      <div className="border-border/60 text-muted-foreground mt-3 rounded-md border border-dashed p-3 text-center text-xs">
        {disabledReason}
      </div>
    );
  }

  const handleTemplateSelect = (template: TemplateRow) => {
    // Try to interpolate with lead data; fall back to raw content
    loadLeadVars(propertyId).then((result) => {
      if (result.ok) {
        setBody(renderTemplate(template.content, result.data));
      } else {
        setBody(template.content);
      }
    });
  };

  return (
    <div className="mt-3 flex flex-col gap-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a reply… (⌘/Ctrl + Enter to send)"
        aria-label="Reply to this lead"
        disabled={pending}
        maxLength={2000}
        rows={2}
        className="border-input placeholder:text-muted-foreground focus-visible:ring-ring min-h-[44px] flex-1 rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
      />
      <div className="flex items-center justify-between">
        <TemplatePicker onSelect={handleTemplateSelect} />
        <div className="flex items-center gap-2">
          <span
            className={`text-[10px] ${tooLong ? "text-destructive" : "text-muted-foreground"}`}
          >
            {length} / 1600
          </span>
          <Button onClick={send} disabled={!canSend} size="sm" aria-label="Send reply">
            <SendIcon className="mr-1 size-3.5" />
            {pending ? "Sending…" : "Send"}
          </Button>
        </div>
      </div>
    </div>
  );
}
