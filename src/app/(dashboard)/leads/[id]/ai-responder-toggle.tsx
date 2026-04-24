"use client";

import { useState, useTransition } from "react";

import { callAction } from "@/lib/errors/call-action";

import { setAiResponderDisabled } from "./ai-actions";

/**
 * Per-property kill switch for the AI responder. Lives inline next to
 * other per-lead widgets on the detail page header. Checkbox-style
 * since it's a single boolean — clearer than a switch at this size.
 */
export function AiResponderToggle({
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
      const r = await callAction(setAiResponderDisabled(propertyId, next), {
        successMessage: next
          ? "AI responder disabled for this lead"
          : "AI responder re-enabled for this lead",
        fallbackMessage: "Could not update AI responder",
      });
      if (!r.ok) setDisabled(previous);
    });
  };

  return (
    <label className="border-border flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
      <input
        type="checkbox"
        checked={!disabled}
        onChange={(e) => onToggle(!e.target.checked)}
        disabled={pending}
        className="h-3.5 w-3.5"
      />
      <span className="text-muted-foreground">🤖 AI responder</span>
    </label>
  );
}
