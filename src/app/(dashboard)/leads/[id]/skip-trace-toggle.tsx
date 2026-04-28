"use client";

import { useState, useTransition } from "react";

import { callAction } from "@/lib/errors/call-action";

import { setSkipTraceDisabled } from "./ai-actions";

/**
 * Per-property skip-trace kill switch. When the box is unchecked
 * (disabled = true), bulk skip-trace requests silently drop this
 * property and single-row requests refuse with a friendly error.
 *
 * Mirrors AiResponderToggle visually so the two kill switches read as
 * a pair on the lead-detail header.
 */
export function SkipTraceToggle({
  propertyId,
  initialDisabled,
}: {
  propertyId: string;
  initialDisabled: boolean;
}) {
  const [disabled, setDisabled] = useState(initialDisabled);
  const [pending, startTransition] = useTransition();

  const onToggle = (next: boolean) => {
    const previous = disabled;
    setDisabled(next); // optimistic
    startTransition(async () => {
      const r = await callAction(setSkipTraceDisabled(propertyId, next), {
        successMessage: next
          ? "Skip-trace disabled for this lead"
          : "Skip-trace re-enabled for this lead",
        fallbackMessage: "Could not update skip-trace setting",
      });
      if (!r.ok) setDisabled(previous);
    });
  };

  return (
    <label
      className="border-border flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
      data-testid="skip-trace-toggle"
    >
      <input
        type="checkbox"
        checked={!disabled}
        onChange={(e) => onToggle(!e.target.checked)}
        disabled={pending}
        className="h-3.5 w-3.5"
        data-testid="skip-trace-toggle-input"
      />
      <span className="text-muted-foreground">🔍 Skip-trace</span>
    </label>
  );
}
