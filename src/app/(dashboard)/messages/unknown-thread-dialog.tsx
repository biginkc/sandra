"use client";

import { formatDistanceToNow } from "date-fns/formatDistanceToNow";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";
import type { Database } from "@/lib/supabase/types";

import { fetchUnknownSenderThread } from "./actions";

type Message = Database["public"]["Tables"]["messages"]["Row"];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromAddress: string;
};

/**
 * Read-only conversation view for an unknown sender. The VA opens this
 * to read context before triaging from the row's dropdown. No actions
 * inside — close to pick from the dropdown.
 */
export function UnknownThreadDialog({ open, onOpenChange, fromAddress }: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) {
      setMessages(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    callAction(fetchUnknownSenderThread(fromAddress), {
      fallbackMessage: "Could not load thread",
    }).then((result) => {
      if (cancelled) return;
      setMessages(result.ok ? result.data : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open, fromAddress]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="unknown-thread-dialog"
      >
        <DialogHeader>
          <DialogTitle>Conversation with {fromAddress}</DialogTitle>
          <DialogDescription>
            Read-only view. Close and use the row's Triage dropdown to merge,
            create, or dismiss.
          </DialogDescription>
        </DialogHeader>

        <div className="border-border max-h-[60vh] overflow-y-auto rounded-md border p-3">
          {loading && (
            <div className="text-muted-foreground py-8 text-center text-sm">
              Loading…
            </div>
          )}
          {!loading && messages && messages.length === 0 && (
            <div className="text-muted-foreground py-8 text-center text-sm">
              No messages from this sender yet.
            </div>
          )}
          {!loading && messages && messages.length > 0 && (
            <div className="flex flex-col gap-2">
              {messages.map((m) => (
                <Bubble key={m.id} message={m} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Bubble({ message }: { message: Message }) {
  const outbound = message.direction === "outbound";
  return (
    <div className={outbound ? "flex justify-end" : "flex justify-start"}>
      <div
        className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
          outbound
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground"
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{message.body}</div>
        <div
          className={`mt-1 text-xs ${
            outbound ? "text-primary-foreground/70" : "text-muted-foreground"
          }`}
        >
          {formatDistanceToNow(new Date(message.created_at), {
            addSuffix: true,
          })}
        </div>
      </div>
    </div>
  );
}
