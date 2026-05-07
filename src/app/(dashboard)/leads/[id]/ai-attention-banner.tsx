"use client";

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
 * Dismiss button clears the flag via a server action. "Acknowledged"
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
  const visible = initialVisible && !dismissed;

  if (!visible) return null;

  const onDismiss = async () => {
    setPending(true);
    try {
      const r = await clearNeedsHumanAttention(propertyId);
      if (r.ok) setDismissed(true);
    } finally {
      setPending(false);
    }
  };

  const friendly = parseEscalationReason(reason)?.longLabel ?? null;
  const when = escalatedAt ? formatRelative(escalatedAt) : null;

  return (
    <div className="border-destructive/40 bg-destructive/10 text-destructive-foreground flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
      <div className="text-destructive flex-1">
        <strong>Needs human attention.</strong>{" "}
        The AI responder escalated this conversation. Review the latest
        inbound message below and reply directly — the AI won&apos;t pick
        this thread up again until you dismiss.
        {(friendly || when) && (
          <div className="text-destructive/80 mt-1 text-xs">
            {friendly ? <>Reason: <code>{friendly}</code></> : null}
            {friendly && when ? " · " : null}
            {when ? <>{when}</> : null}
          </div>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onDismiss}
        disabled={pending}
      >
        Dismiss
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
