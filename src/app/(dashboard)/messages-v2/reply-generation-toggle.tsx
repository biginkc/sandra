"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Result } from "@/lib/errors/result";
import { cn } from "@/lib/utils";

import type { ReplyGeneration, ReplyGenerationSetting } from "./reply-generation";

export type SetReplyGenerationAction = (input: {
  configId: string;
  mode: ReplyGeneration;
}) => Promise<Result<ReplyGenerationSetting>>;

/**
 * "AI drafts: on/off" in the Messages v2 header. Off = Jev-only: Jev still
 * classifies and applies outcomes, but nothing is drafted by the LLM and every
 * seller reply that needs an answer is held for a human. Owners get a button
 * with a confirm step; everyone else sees a read-only badge.
 */
export function ReplyGenerationToggle({
  configId,
  replyGeneration,
  isOwner,
  action,
}: {
  configId: string | null;
  replyGeneration: ReplyGeneration | null;
  isOwner: boolean;
  action?: SetReplyGenerationAction;
}) {
  const [current, setCurrent] = useState(replyGeneration);
  const [synced, setSynced] = useState(replyGeneration);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (synced !== replyGeneration) {
    setSynced(replyGeneration);
    setCurrent(replyGeneration);
  }

  if (!configId || !current) return null;
  const on = current === "llm";
  const label = `AI drafts: ${on ? "on" : "off"}`;
  const tone = on
    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"
    : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200";

  if (!isOwner || !action) {
    return (
      <Badge variant="outline" data-testid="reply-generation-badge" className={cn("gap-1", tone)}>
        {label}
      </Badge>
    );
  }

  const next: ReplyGeneration = on ? "off" : "llm";
  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      const result = await action({ configId, mode: next });
      if (result.ok) {
        setCurrent(result.data.replyGeneration);
        setOpen(false);
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("Could not change AI drafts. Nothing was changed.");
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        size="xs"
        variant="outline"
        data-testid="reply-generation-toggle"
        className={tone}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{on ? "Turn AI drafts off?" : "Turn AI drafts on?"}</DialogTitle>
            <DialogDescription>
              {on
                ? "Jev keeps classifying and applying outcomes. The AI will stop writing replies: every seller message that needs an answer is held for a human as 'Seller replied — needs a human reply'."
                : "The AI responder may draft replies again, under the current send and hold rules."}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-sm text-red-700 dark:text-red-300">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" disabled={pending} onClick={confirm}>
              {on ? "Turn off" : "Turn on"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
