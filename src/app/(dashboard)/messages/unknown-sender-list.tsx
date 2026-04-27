"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { callAction } from "@/lib/errors/call-action";
import type { UnknownSender } from "@/lib/messages/list-unknown-senders";

import {
  dismissUnknownSenderAction,
  restoreDismissedSenderAction,
} from "./actions";
import { CreateContactDialog } from "./create-contact-dialog";
import { MatchSenderDialog } from "./match-sender-dialog";

type Props = {
  senders: UnknownSender[];
  showRestore: boolean;
};

/**
 * Renders the Unknown bucket. Each row collapses every message from a
 * given from_address into a single line with a count and the latest
 * preview. Action menu per row: Match, Create, Dismiss (or Restore on
 * the Dismissed sub-tab).
 */
export function UnknownSenderList({ senders, showRestore }: Props) {
  if (senders.length === 0) {
    return (
      <div
        className="border-border/60 text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm"
        data-testid={
          showRestore ? "dismissed-empty" : "unknown-empty"
        }
      >
        {showRestore
          ? "Nothing dismissed."
          : "No unknown senders. When someone texts the BMH number who isn't in your contacts, they'll appear here."}
      </div>
    );
  }

  return (
    <div
      className="border-border rounded-md border divide-y"
      data-testid="unknown-sender-list"
    >
      {senders.map((s) => (
        <UnknownRow
          key={s.fromAddress}
          sender={s}
          showRestore={showRestore}
        />
      ))}
    </div>
  );
}

function UnknownRow({
  sender,
  showRestore,
}: {
  sender: UnknownSender;
  showRestore: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [matchOpen, setMatchOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const dismiss = () => {
    if (!window.confirm(`Dismiss all messages from ${sender.fromAddress}?`)) {
      return;
    }
    startTransition(async () => {
      const result = await callAction(
        dismissUnknownSenderAction(sender.fromAddress),
        {
          successMessage: "Dismissed.",
          fallbackMessage: "Could not dismiss",
        },
      );
      if (result.ok) router.refresh();
    });
  };

  const restore = () => {
    startTransition(async () => {
      const result = await callAction(
        restoreDismissedSenderAction(sender.fromAddress),
        {
          successMessage: "Restored.",
          fallbackMessage: "Could not restore",
        },
      );
      if (result.ok) router.refresh();
    });
  };

  return (
    <div
      className="flex items-start justify-between gap-3 p-3"
      data-testid={`unknown-row-${sender.fromAddress}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium">
            {sender.fromAddress}
          </span>
          {sender.messageCount > 1 ? (
            <Badge variant="secondary" className="text-[10px]">
              {sender.messageCount} msgs
            </Badge>
          ) : null}
          <span className="text-muted-foreground ml-auto text-[11px]">
            {formatDistanceToNow(new Date(sender.latestAt), { addSuffix: true })}
          </span>
        </div>
        <div className="text-muted-foreground line-clamp-2 mt-1 text-xs">
          {sender.latestBody}
        </div>
      </div>
      <div className="shrink-0">
        {showRestore ? (
          <Button
            variant="outline"
            size="sm"
            onClick={restore}
            disabled={pending}
            data-testid={`unknown-restore-${sender.fromAddress}`}
          >
            Restore
          </Button>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  data-testid={`unknown-actions-${sender.fromAddress}`}
                >
                  Triage
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setMatchOpen(true)}
                data-testid={`unknown-match-${sender.fromAddress}`}
              >
                Match to existing lead…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setCreateOpen(true)}
                data-testid={`unknown-create-${sender.fromAddress}`}
              >
                Create new contact + property…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={dismiss}
                data-testid={`unknown-dismiss-${sender.fromAddress}`}
              >
                Dismiss
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      <MatchSenderDialog
        open={matchOpen}
        onOpenChange={setMatchOpen}
        fromAddress={sender.fromAddress}
        latestBody={sender.latestBody}
      />
      <CreateContactDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        fromAddress={sender.fromAddress}
      />
    </div>
  );
}
