"use client";

import {
  PencilIcon,
  PowerIcon,
  RefreshCwIcon,
} from "lucide-react";
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
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/errors/call-action";

import {
  rotateWebhookConsumer,
  toggleWebhookConsumer,
  updateWebhookConsumerNotes,
} from "./actions";
import { SuccessState } from "./create-consumer-dialog";
import type { WebhookConsumerType } from "./url";

type Props = {
  id: string;
  name: string;
  consumerType: WebhookConsumerType;
  enabled: boolean;
  notes: string | null;
};

/**
 * Actions cluster for a single consumer row: rotate, toggle, edit
 * notes. Each surfaces its own confirmation dialog so an admin can't
 * misclick a destructive action. Rotate piggybacks on the same
 * one-time-secret display the create flow uses.
 */
export function RowActions({
  id,
  name,
  consumerType,
  enabled,
  notes,
}: Props) {
  return (
    <div className="flex items-center justify-end gap-1">
      <RotateButton id={id} name={name} consumerType={consumerType} />
      <ToggleButton id={id} name={name} enabled={enabled} />
      <NotesButton id={id} name={name} notes={notes} />
    </div>
  );
}

function RotateButton({
  id,
  name,
  consumerType,
}: {
  id: string;
  name: string;
  consumerType: WebhookConsumerType;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [success, setSuccess] = useState<{
    plaintextSecret: string;
    url: string;
  } | null>(null);

  const rotate = () => {
    startTransition(async () => {
      const result = await callAction(rotateWebhookConsumer(id), {
        fallbackMessage: "Rotate failed",
      });
      if (result.ok) {
        setSuccess({
          plaintextSecret: result.data.plaintextSecret,
          url: result.data.url,
        });
      }
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      const wasSuccess = success !== null;
      setSuccess(null);
      if (wasSuccess) router.refresh();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Rotate secret for ${name}`}
      >
        <RefreshCwIcon className="mr-1 size-3.5" /> Rotate
      </Button>
      <DialogContent className="sm:max-w-lg">
        {success ? (
          <SuccessState
            secret={success.plaintextSecret}
            url={success.url}
            name={name}
            type={consumerType}
            onClose={() => handleOpenChange(false)}
            title="Secret rotated"
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Rotate secret for {name}?</DialogTitle>
              <DialogDescription>
                A new secret will be generated and the old one will stop
                working immediately. There&apos;s no grace period — make
                sure the integrator is ready to switch over before you
                rotate.
              </DialogDescription>
            </DialogHeader>
            <div className="border-destructive/40 bg-destructive/5 rounded-md border p-3 text-sm">
              The new plaintext secret will be shown exactly once.
              Copy it before closing the dialog.
            </div>
            <DialogFooter>
              <DialogClose
                render={<Button variant="outline" disabled={pending} />}
              >
                Cancel
              </DialogClose>
              <Button
                onClick={rotate}
                disabled={pending}
                data-testid="rotate-confirm"
              >
                {pending ? "Rotating…" : "Rotate now"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ToggleButton({
  id,
  name,
  enabled,
}: {
  id: string;
  name: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    startTransition(async () => {
      const result = await callAction(toggleWebhookConsumer(id, !enabled), {
        successMessage: enabled
          ? `Disabled "${name}"`
          : `Enabled "${name}"`,
        fallbackMessage: enabled
          ? "Could not disable consumer"
          : "Could not enable consumer",
      });
      if (result.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={enabled ? `Disable ${name}` : `Enable ${name}`}
      >
        <PowerIcon className="mr-1 size-3.5" />
        {enabled ? "Disable" : "Enable"}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {enabled ? "Disable" : "Enable"} {name}?
          </DialogTitle>
          <DialogDescription>
            {enabled ? (
              <>
                Disabling sets the row&apos;s <code>revoked_at</code> to
                now and stops the secret from authenticating any further
                webhook calls. Re-enabling later clears the revocation
                timestamp.
              </>
            ) : (
              <>
                Re-enabling clears the revocation timestamp and lets the
                existing secret authenticate again. If you want a fresh
                secret instead, rotate after re-enabling.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose
            render={<Button variant="outline" disabled={pending} />}
          >
            Cancel
          </DialogClose>
          <Button
            onClick={toggle}
            disabled={pending}
            data-testid="toggle-confirm"
          >
            {pending
              ? "Saving…"
              : enabled
                ? "Disable consumer"
                : "Enable consumer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NotesButton({
  id,
  name,
  notes,
}: {
  id: string;
  name: string;
  notes: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [pending, startTransition] = useTransition();

  const save = () => {
    startTransition(async () => {
      const result = await callAction(
        updateWebhookConsumerNotes(id, draft),
        {
          successMessage: "Notes saved",
          fallbackMessage: "Could not save notes",
        },
      );
      if (result.ok) {
        setOpen(false);
        router.refresh();
      }
    });
  };

  // When the dialog opens, sync the draft to the latest notes prop —
  // a sibling action's router.refresh() may have updated it since the
  // last open.
  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(notes ?? "");
    setOpen(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Edit notes for ${name}`}
      >
        <PencilIcon className="mr-1 size-3.5" /> Notes
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Notes for {name}</DialogTitle>
          <DialogDescription>
            Internal-only context. Visible to admins on the webhooks page.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`notes-${id}`}>Notes</Label>
          <Textarea
            id={`notes-${id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={1_000}
            disabled={pending}
            placeholder="e.g. Enzo dialer rotation 2026-04-29 — VAs Mateo and Liz."
            data-testid="notes-input"
          />
        </div>
        <DialogFooter>
          <DialogClose
            render={<Button variant="outline" disabled={pending} />}
          >
            Cancel
          </DialogClose>
          <Button
            onClick={save}
            disabled={pending}
            data-testid="notes-save"
          >
            {pending ? "Saving…" : "Save notes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
