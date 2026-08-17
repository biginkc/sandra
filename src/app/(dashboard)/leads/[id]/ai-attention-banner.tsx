"use client";

import { AlertTriangleIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { parseEscalationReason } from "@/lib/ai-responder/format-reason";

import { clearNeedsHumanAttention } from "./ai-actions";

/**
 * Banner shown on lead detail when `properties.needs_human_attention`
 * is true. Fires when the AI responder escalates a thread — keyword
 * match, low confidence, frustrated sentiment, unsafe body, or
 * provider error.
 *
 * Mark handled clears the flag via the existing server action. "Acknowledged"
 * is implicit: viewing the lead detail doesn't auto-clear, so the
 * flag stays persistent until the VA explicitly acts.
 */
export function AiAttentionBanner({
  propertyId,
  initialVisible,
  reason,
  escalatedAt,
}: {
  propertyId: string;
  initialVisible: boolean;
  reason?: string | null;
  escalatedAt?: string | null;
}) {
  // `initialVisible` is the source of truth (re-fetched on each
  // server-rendered page load); `dismissed` carries the optimistic
  // local "I just clicked X" until the next render reconciles.
  const [dismissed, setDismissed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const visible = initialVisible && !dismissed;

  if (!visible) return null;

  const onDismiss = async () => {
    setPending(true);
    setFailure(null);
    try {
      const r = await clearNeedsHumanAttention(propertyId);
      if (r.ok) {
        setDismissed(true);
      } else {
        setFailure(r.error.message);
      }
    } catch (error) {
      setFailure(
        error instanceof Error
          ? error.message
          : "Could not clear the attention flag",
      );
    } finally {
      setPending(false);
    }
  };

  const friendly = parseEscalationReason(reason)?.longLabel ?? null;
  const when = escalatedAt ? formatRelative(escalatedAt) : null;

  return (
    <div
      className="border-destructive/40 bg-destructive/10 text-destructive-foreground flex flex-col gap-3 rounded-lg border p-4 text-sm sm:flex-row sm:items-start sm:justify-between"
      role="alert"
      data-testid="ai-attention-banner"
    >
      <div className="text-destructive flex min-w-0 flex-1 gap-3">
        <AlertTriangleIcon className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div>
          <strong>Human reply needed.</strong> Sandra paused on this
          conversation. Review the latest inbound message and take over
          directly.
          {(friendly || when) && (
            <div className="text-destructive/80 mt-1 text-xs">
              {friendly ? (
                <>
                  Reason: <code>{friendly}</code>
                </>
              ) : null}
              {friendly && when ? " · " : null}
              {when ? <>{when}</> : null}
            </div>
          )}
          {failure ? (
            <div
              className="mt-2 text-xs font-semibold"
              data-testid="ai-attention-failure"
            >
              Could not mark this handled: {failure}. You can retry safely.
            </div>
          ) : null}
        </div>
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onDismiss}
        disabled={pending}
        className="min-h-11 w-full sm:min-h-8 sm:w-auto"
        data-testid="ai-attention-mark-handled"
      >
        {failure ? <RotateCcwIcon className="size-3.5" /> : null}
        {pending ? "Marking…" : failure ? "Retry" : "Mark handled"}
      </Button>
    </div>
  );
}

/** "5 minutes ago" / "2 hours ago" — small inline helper to avoid pulling
 *  date-fns into this client component just for one string. */
function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
