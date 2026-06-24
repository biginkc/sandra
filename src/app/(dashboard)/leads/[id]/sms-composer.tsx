"use client";

import { MessageSquareIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/errors/call-action";
import type { DialpadFromOption } from "@/lib/messaging/types";

import { listFromNumbers, sendSmsFromLead } from "../actions";

type TemplatePick = {
  id: string;
  name: string;
  body: string;
};

type Props = {
  propertyId: string;
  homeownerContactId: string | null;
  homeownerPhone: string | null;
  homeownerName: string | null;
  templates?: TemplatePick[];
};

export function SmsComposer({
  propertyId,
  homeownerContactId,
  homeownerPhone,
  homeownerName,
  templates = [],
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [pending, startTransition] = useTransition();
  const [fromOptions, setFromOptions] = useState<DialpadFromOption[]>([]);
  const [fromNumber, setFromNumber] = useState<string>("");
  const [loadingFroms, setLoadingFroms] = useState(false);

  // Fetch the account's phone numbers the first time the dialog opens.
  // Keep the list cached across opens so the dropdown pops instantly.
  useEffect(() => {
    if (!open || fromOptions.length > 0 || loadingFroms) return;
    setLoadingFroms(true);
    listFromNumbers()
      .then((result) => {
        if (result.ok) {
          // Dialpad rejects sending from "available" (unassigned) numbers
          // with a 400 — hide them from the picker so we can't pick a
          // dud. Keep user + office + group numbers.
          const sendable = result.data.filter(
            (o) => o.status !== "available",
          );
          setFromOptions(sendable);
          if (sendable.length > 0 && !fromNumber) {
            setFromNumber(sendable[0].number);
          }
        } else {
          toast.error("Could not load phone numbers", {
            description: result.error.message,
          });
        }
      })
      .finally(() => setLoadingFroms(false));
  }, [open, fromOptions.length, fromNumber, loadingFroms]);

  const disabled = !homeownerContactId || !homeownerPhone;
  const disabledReason = !homeownerContactId
    ? "No homeowner contact linked to this lead."
    : !homeownerPhone
      ? "Homeowner has no phone number."
      : null;

  const length = body.length;
  const tooLong = length > 1600;

  const sendOrQueue = (queueOnly: boolean) => {
    startTransition(async () => {
      const result = await callAction(
        sendSmsFromLead(propertyId, body, fromNumber || null, queueOnly),
        { fallbackMessage: queueOnly ? "Queue failed" : "SMS send failed" },
      );
      if (!result.ok) return;

      const { outcome } = result.data;
      switch (outcome.status) {
        case "sent":
          toast.success("Message sent", {
            description: `Delivered to ${homeownerPhone}.`,
          });
          setBody("");
          setOpen(false);
          router.refresh();
          break;
        case "queued":
          toast.success("Queued", {
            description: "Release it from the Messages page.",
          });
          setBody("");
          setOpen(false);
          router.refresh();
          break;
        case "blocked_no_consent":
          toast.error("Blocked: no consent", {
            description: outcome.reason,
          });
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" disabled={disabled} aria-label="Send SMS">
            <MessageSquareIcon className="size-3.5" />
            <span>Send SMS</span>
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Send SMS</DialogTitle>
          <DialogDescription>
            {disabled ? (
              disabledReason
            ) : (
              <>
                To <span className="font-medium">{homeownerName ?? homeownerPhone}</span>{" "}
                at <span className="font-mono text-xs">{homeownerPhone}</span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="sms-from">Send from</Label>
          <select
            id="sms-from"
            className="border-input bg-transparent rounded-md border px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
            value={fromNumber}
            onChange={(e) => setFromNumber(e.target.value)}
            disabled={loadingFroms || pending}
          >
            {loadingFroms && <option value="">Loading numbers…</option>}
            {!loadingFroms && fromOptions.length === 0 && (
              <option value="">No numbers found — check SMS provider config</option>
            )}
            {fromOptions.map((o) => (
              <option key={o.number} value={o.number}>
                {o.number} · {o.ownerName}
                {o.status !== "user" && o.status !== "office"
                  ? ` (${o.status})`
                  : ""}
              </option>
            ))}
          </select>
        </div>

        {templates.length > 0 && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="sms-template">Template</Label>
            <select
              id="sms-template"
              className="border-input bg-transparent rounded-md border px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
              value={selectedTemplateId}
              onChange={(e) => {
                const id = e.target.value;
                if (!id) return;
                const tpl = templates.find((t) => t.id === id);
                if (tpl) setBody(tpl.body);
                setSelectedTemplateId("");
              }}
              disabled={disabled || pending}
            >
              <option value="">Select a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="sms-body">Message</Label>
          <textarea
            id="sms-body"
            className="border-input placeholder:text-muted-foreground focus-visible:ring-ring min-h-[120px] rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
            placeholder="Type your message…"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            disabled={disabled || pending}
            maxLength={2000}
          />
          <div className="flex items-center justify-end text-xs">
            <span className={tooLong ? "text-destructive" : "text-muted-foreground"}>
              {length} / 1600
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => sendOrQueue(true)}
            disabled={disabled || pending || length === 0 || tooLong}
          >
            {pending ? "Working…" : "Queue"}
          </Button>
          <Button
            onClick={() => sendOrQueue(false)}
            disabled={disabled || pending || length === 0 || tooLong}
          >
            {pending ? "Sending…" : "Send now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
