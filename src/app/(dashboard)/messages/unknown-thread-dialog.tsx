"use client";

import { formatDistance } from "date-fns/formatDistance";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";
import type { Database } from "@/lib/supabase/types";

import { fetchUnknownSenderThread } from "./actions";

type Message = Database["public"]["Tables"]["messages"]["Row"];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromAddress: string;
  nowMs: number;
};

/**
 * Read-only conversation view for an unknown sender. The VA opens this
 * to read context before triaging from the row's dropdown. No actions
 * inside — close to pick from the dropdown.
 */
export function UnknownThreadDialog({
  open,
  onOpenChange,
  fromAddress,
  nowMs,
}: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const loading = open && messages === null;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    callAction(fetchUnknownSenderThread(fromAddress), {
      fallbackMessage: "Could not load thread",
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setMessages(result.data);
        return;
      }
      setMessages([]);
      setLoadError("Could not load this conversation.");
    });
    return () => {
      cancelled = true;
    };
  }, [open, fromAddress, loadAttempt]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setMessages(null);
      setLoadError(null);
      setLoadAttempt(0);
    }
    onOpenChange(nextOpen);
  };

  const retry = () => {
    setMessages(null);
    setLoadError(null);
    setLoadAttempt((attempt) => attempt + 1);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-lg"
        data-testid="unknown-thread-dialog"
      >
        <DialogHeader>
          <DialogTitle>Conversation with {fromAddress}</DialogTitle>
          <DialogDescription>
            Read-only view. Close and use the row&apos;s Triage dropdown to merge,
            create, or dismiss.
          </DialogDescription>
        </DialogHeader>

        <div className="border-border max-h-[60vh] overflow-y-auto rounded-md border p-3">
          {loading && (
            <div className="text-muted-foreground py-8 text-center text-sm">
              Loading…
            </div>
          )}
          {!loading && loadError && (
            <div
              className="flex flex-col items-center gap-3 py-8 text-center"
              role="alert"
              data-testid="unknown-thread-load-error"
            >
              <p className="text-muted-foreground text-sm">{loadError}</p>
              <Button className="min-h-11" onClick={retry}>
                Retry
              </Button>
            </div>
          )}
          {!loading && !loadError && messages && messages.length === 0 && (
            <div className="text-muted-foreground py-8 text-center text-sm">
              No messages from this sender yet.
            </div>
          )}
          {!loading && !loadError && messages && messages.length > 0 && (
            <div className="flex flex-col gap-2">
              {messages.map((m) => (
                <Bubble key={m.id} message={m} nowMs={nowMs} />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Bubble({ message, nowMs }: { message: Message; nowMs: number }) {
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
          {formatDistance(new Date(message.created_at), new Date(nowMs), {
            addSuffix: true,
          })}
        </div>
      </div>
    </div>
  );
}
