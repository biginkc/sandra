"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";

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
}: {
  propertyId: string;
  initialVisible: boolean;
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

  return (
    <div className="border-destructive/40 bg-destructive/10 text-destructive-foreground flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
      <div className="text-destructive">
        <strong>Needs human attention.</strong>{" "}
        The AI responder escalated this conversation. Review the latest
        inbound message below and reply directly — the AI won&apos;t pick
        this thread up again until you dismiss.
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
