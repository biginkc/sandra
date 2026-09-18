"use client";

import { useState, useTransition } from "react";
import { callAction } from "@/lib/errors/call-action";
import {
  dismissUnknownSenderAction,
  restoreDismissedSenderAction,
} from "@/app/(dashboard)/messages/actions";
import { CreateContactDialog } from "@/app/(dashboard)/messages/create-contact-dialog";
import { MatchSenderDialog } from "@/app/(dashboard)/messages/match-sender-dialog";
import { MergePropertyDialog } from "@/app/(dashboard)/messages/merge-property-dialog";

type Props = {
  fromAddress: string;
  latestBody: string;
  dismissed: boolean;
  onChanged: () => void;
};

/**
 * Individual unknown-sender triage in the new Inbox detail pane. These are
 * the same authorized server actions and dialogs used by Messages; the Inbox
 * owns only the entry point and refreshes its bounded workspace after a
 * disposition changes.
 */
export function InboxUnknownSenderActions({
  fromAddress,
  latestBody,
  dismissed,
  onChanged,
}: Props) {
  const [matchOpen, setMatchOpen] = useState(false);
  const [mergePropertyOpen, setMergePropertyOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function closeAndRefresh(setOpen: (open: boolean) => void, open: boolean) {
    setOpen(open);
    if (!open) onChanged();
  }

  function dismiss() {
    if (!window.confirm(`Dismiss all messages from ${fromAddress}?`)) return;
    startTransition(async () => {
      const result = await callAction(dismissUnknownSenderAction(fromAddress), {
        successMessage: "Dismissed.",
        fallbackMessage: "Could not dismiss",
      });
      if (result.ok) onChanged();
    });
  }

  function restore() {
    startTransition(async () => {
      const result = await callAction(restoreDismissedSenderAction(fromAddress), {
        successMessage: "Restored.",
        fallbackMessage: "Could not restore",
      });
      if (result.ok) onChanged();
    });
  }

  return (
    <section aria-label="Unknown sender actions" className="mt-4 rounded border p-3">
      <h3 className="font-medium">Unknown sender</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Resolve this sender before treating the messages as a known contact.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {dismissed ? (
          <button type="button" className="rounded border px-3 py-2 text-sm" disabled={pending} onClick={restore}>
            Restore sender
          </button>
        ) : (
          <>
            <button type="button" className="rounded border px-3 py-2 text-sm" disabled={pending} onClick={() => setMatchOpen(true)}>
              Merge with existing contact
            </button>
            <button type="button" className="rounded border px-3 py-2 text-sm" disabled={pending} onClick={() => setMergePropertyOpen(true)}>
              Merge with existing property
            </button>
            <button type="button" className="rounded border px-3 py-2 text-sm" disabled={pending} onClick={() => setCreateOpen(true)}>
              Create new lead
            </button>
            <button type="button" className="rounded border px-3 py-2 text-sm" disabled={pending} onClick={dismiss}>
              Dismiss sender
            </button>
          </>
        )}
      </div>
      <MatchSenderDialog open={matchOpen} onOpenChange={(open) => closeAndRefresh(setMatchOpen, open)} fromAddress={fromAddress} latestBody={latestBody} />
      <MergePropertyDialog open={mergePropertyOpen} onOpenChange={(open) => closeAndRefresh(setMergePropertyOpen, open)} fromAddress={fromAddress} latestBody={latestBody} />
      <CreateContactDialog open={createOpen} onOpenChange={(open) => closeAndRefresh(setCreateOpen, open)} fromAddress={fromAddress} />
    </section>
  );
}
