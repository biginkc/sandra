"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FACT_LABELS, type FactField } from "@/lib/call-facts/types";

import type { CallFactActionResult } from "./facts-actions";
import type { LeadCallFactsView } from "./types";

export type CallFactChipsProps = {
  facts: LeadCallFactsView;
  onAccept: (field: FactField) => Promise<CallFactActionResult>;
  onDismiss: () => Promise<CallFactActionResult>;
  /** Called after a successful accept so the screen can prefill its own fields and refresh. */
  onAccepted?: (field: FactField, value: string) => void;
  onDismissed?: () => void;
};

const CENTRAL_STAMP = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
});

/** The stored next_step value is an ISO instant; everything else is shown as stored. */
function display(field: FactField, value: string): string {
  if (field !== "next_step") return value;
  const at = Date.parse(value);
  return Number.isFinite(at) ? CENTRAL_STAMP.format(new Date(at)) : value;
}

/**
 * Proposed call facts (§3.12). One chip per field with the seller's own words as evidence; nothing
 * is saved until a person taps Accept. `condition` arrives last by design (lowest priority).
 */
export function CallFactChips({ facts, onAccept, onDismiss, onAccepted, onDismissed }: CallFactChipsProps) {
  const [done, setDone] = useState<Set<FactField>>(new Set());
  const [busy, setBusy] = useState<FactField | "dismiss" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const chips = facts.chips.filter((c) => !done.has(c.field));
  if (dismissed || chips.length === 0) return null;

  const accept = async (field: FactField, value: string) => {
    if (busy) return;
    setBusy(field);
    setError(null);
    try {
      const result = await onAccept(field);
      if (result.ok) {
        setDone((prev) => new Set(prev).add(field));
        onAccepted?.(field, result.value ?? value);
      } else {
        setError(result.message);
      }
    } catch {
      setError("That suggestion could not be saved. Please retry.");
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    if (busy) return;
    setBusy("dismiss");
    setError(null);
    try {
      const result = await onDismiss();
      if (result.ok) {
        setDismissed(true);
        onDismissed?.();
      } else {
        setError(result.message);
      }
    } catch {
      setError("That could not be dismissed. Please retry.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="call-fact-chips" aria-label="Suggestions from the call summary" className="flex flex-col gap-2 rounded-[16px] border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">From the call</h2>
        <Button type="button" variant="ghost" size="sm" data-testid="call-fact-dismiss" disabled={busy !== null} onClick={() => void dismiss()}>
          Dismiss
        </Button>
      </div>
      <ul className="flex flex-col gap-2">
        {chips.map((chip) => (
          <li key={chip.field} data-testid={`call-fact-chip-${chip.field}`} className="flex items-start justify-between gap-3 rounded-[12px] border border-border px-3 py-2">
            <div className="min-w-0">
              <p className="text-muted-foreground text-xs">{FACT_LABELS[chip.field]}</p>
              <p className="text-sm font-medium">{display(chip.field, chip.value)}</p>
              <p data-testid={`call-fact-evidence-${chip.field}`} title={chip.evidence} className="text-muted-foreground truncate text-xs italic">
                &ldquo;{chip.evidence}&rdquo;
              </p>
            </div>
            <Button type="button" size="sm" data-testid={`call-fact-accept-${chip.field}`} disabled={busy !== null} onClick={() => void accept(chip.field, chip.value)}>
              {busy === chip.field ? "Saving" : "Accept"}
            </Button>
          </li>
        ))}
      </ul>
      {error ? <p role="alert" className="text-destructive text-xs">{error}</p> : null}
    </section>
  );
}
