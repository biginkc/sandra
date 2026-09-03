"use client";

import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/errors/call-action";
import { copyToClipboard } from "@/lib/csv/export";
import { LEAD_SOURCES, type LeadSource } from "@/lib/leads/sources";
import {
  LEAD_SOURCE_LABELS,
  systemLabel,
} from "@/lib/presentation/system-labels";

import { createWebhookConsumer } from "./actions";
import type { WebhookConsumerType } from "./url";

/**
 * "Add webhook consumer" dialog. Two states:
 *
 *   1. Form — name, type (lead/provider), default_source (lead only),
 *      notes. Submit creates the consumer.
 *   2. Success — shows the plaintext secret + full URL exactly once,
 *      with copy buttons. Closing this state navigates back to the
 *      list and never re-shows the secret.
 *
 * The router refresh runs only after the success state is dismissed,
 * so the new row appears in the table the moment the user closes the
 * dialog. (Refreshing during the success state would unmount the
 * one-time secret display — bad UX.)
 */
export function CreateConsumerDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  // Form state
  const [name, setName] = useState("");
  const [consumerType, setConsumerType] = useState<WebhookConsumerType>("lead");
  const [defaultSource, setDefaultSource] = useState<LeadSource | "">("");
  const [notes, setNotes] = useState("");

  // One-time display state
  const [success, setSuccess] = useState<{
    plaintextSecret: string;
    url: string;
    name: string;
    type: WebhookConsumerType;
  } | null>(null);

  const reset = () => {
    setName("");
    setConsumerType("lead");
    setDefaultSource("");
    setNotes("");
    setSuccess(null);
  };

  const canSubmit =
    !pending &&
    name.trim().length > 0 &&
    (consumerType === "provider" || defaultSource !== "");

  const submit = () => {
    if (!canSubmit) return;
    startTransition(async () => {
      const result = await callAction(
        createWebhookConsumer({
          name: name.trim(),
          consumer_type: consumerType,
          default_source:
            consumerType === "lead" ? (defaultSource as LeadSource) : null,
          notes: notes.trim() || null,
        }),
        { fallbackMessage: "Could not create webhook consumer" },
      );
      if (result.ok) {
        setSuccess({
          plaintextSecret: result.data.plaintextSecret,
          url: result.data.url,
          name: name.trim(),
          type: consumerType,
        });
      }
    });
  };

  // When the dialog fully closes (after a success or a cancel),
  // refresh the page so the new row shows up. We delay the refresh
  // until close so the success state's plaintext isn't unmounted by
  // a router.refresh() mid-render.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      const wasSuccess = success !== null;
      reset();
      if (wasSuccess) router.refresh();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button>
            <PlusIcon className="mr-1 size-3.5" />
            Add webhook consumer
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        {success ? (
          <SuccessState
            secret={success.plaintextSecret}
            url={success.url}
            name={success.name}
            type={success.type}
            onClose={() => handleOpenChange(false)}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Add webhook consumer</DialogTitle>
              <DialogDescription>
                Each consumer gets its own secret. Lead consumers feed the
                lead-intake webhook; provider consumers receive results
                callbacks (skip-trace and similar). The plaintext secret will be
                shown exactly once after submit.
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="webhook-name">Name *</Label>
              <Input
                id="webhook-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Enzo Dialer"
                maxLength={80}
                disabled={pending}
                data-testid="webhook-name"
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label>Type *</Label>
              <RadioGroup
                value={consumerType}
                onValueChange={(v) => {
                  const next = v as WebhookConsumerType;
                  setConsumerType(next);
                  // Clear default_source when switching to provider so a
                  // stale value can't ride along; the action also rejects
                  // provider+source pairs as defense-in-depth.
                  if (next === "provider") setDefaultSource("");
                }}
                className="grid grid-cols-2 gap-3"
              >
                <label
                  className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  data-testid="type-lead"
                >
                  <RadioGroupItem value="lead" />
                  <div className="flex flex-col">
                    <span className="font-medium">Lead</span>
                    <span className="text-muted-foreground text-xs">
                      Inbound lead-intake webhook
                    </span>
                  </div>
                </label>
                <label
                  className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  data-testid="type-provider"
                >
                  <RadioGroupItem value="provider" />
                  <div className="flex flex-col">
                    <span className="font-medium">Provider</span>
                    <span className="text-muted-foreground text-xs">
                      Skip-trace results callback
                    </span>
                  </div>
                </label>
              </RadioGroup>
            </div>

            {consumerType === "lead" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="webhook-source">Default source *</Label>
                <Select
                  value={defaultSource}
                  onValueChange={(v) => setDefaultSource(v as LeadSource)}
                >
                  <SelectTrigger
                    id="webhook-source"
                    data-testid="webhook-source"
                    className="w-full"
                  >
                    <SelectValue placeholder="Pick a source…" />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_SOURCES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {systemLabel(LEAD_SOURCE_LABELS, s)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-muted-foreground text-xs">
                  Stamped onto every property created via this webhook unless
                  the payload includes its own <code>source</code>.
                </p>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="webhook-notes">Notes</Label>
              <Textarea
                id="webhook-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional context: who runs this integration, when it was set up, anything future-you would want to know."
                maxLength={1_000}
                disabled={pending}
                data-testid="webhook-notes"
              />
            </div>

            <DialogFooter>
              <DialogClose
                render={<Button variant="outline" disabled={pending} />}
              >
                Cancel
              </DialogClose>
              <Button
                onClick={submit}
                disabled={!canSubmit}
                data-testid="webhook-submit"
              >
                {pending ? "Creating…" : "Create consumer"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One-time-display panel for a freshly-created secret. Mirrors the
 * pattern used for rotate. Copy buttons + a clear "this is the only
 * time you'll see it" warning. Closing this panel unmounts the secret
 * permanently — there's no recovery path.
 */
export function SuccessState({
  secret,
  url,
  name,
  type,
  onClose,
  title = "Webhook consumer created",
}: {
  secret: string;
  url: string;
  name: string;
  type: WebhookConsumerType;
  onClose: () => void;
  title?: string;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          <span className="text-foreground font-semibold">{name}</span> ({type})
          — copy the secret now. We don&apos;t store the plaintext; if you lose
          it, you&apos;ll have to rotate the consumer.
        </DialogDescription>
      </DialogHeader>

      <div
        className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm"
        data-testid="webhook-success"
      >
        <div className="text-foreground mb-2 font-semibold">
          This is the only time you&apos;ll see this — copy it now.
        </div>
        <p className="text-muted-foreground text-xs">
          The secret is hashed and stored. After you close this dialog, there is
          no way to retrieve it. Refreshing the page won&apos;t show it again.
        </p>
      </div>

      <CopyableField
        label="Secret"
        value={secret}
        testId="webhook-secret-value"
      />

      <CopyableField
        label="Webhook URL (give this to the integrator)"
        value={url}
        testId="webhook-url-value"
      />

      <DialogFooter>
        <Button onClick={onClose} data-testid="webhook-success-close">
          I&apos;ve copied it — close
        </Button>
      </DialogFooter>
    </>
  );
}

function CopyableField({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2_000);
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-stretch gap-2">
        <code
          className="border-border bg-muted/40 flex-1 break-all rounded-md border px-2.5 py-2 font-mono text-xs"
          data-testid={testId}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={`Copy ${label}`}
          className="shrink-0"
        >
          {copied ? (
            <>
              <CheckIcon className="mr-1 size-3.5" /> Copied
            </>
          ) : (
            <>
              <CopyIcon className="mr-1 size-3.5" /> Copy
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
