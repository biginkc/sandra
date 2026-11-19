"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { markNormaRequestReviewed } from "./actions";

export type NormaReviewRow = {
  id: string;
  propertyId: string;
  address: string;
  summary: string | null;
  outcome: string | null;
  updatedAt: string;
  selected: boolean;
};

/**
 * Norma calls waiting for a person to review them, opened from a My Leads Broken item (by request id, or by lead until
 * the item carries one). Mark reviewed is the lead page's existing action (same core, same SQL rules).
 */
export function NormaReviewCard({ rows }: { rows: NormaReviewRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (rows.length === 0) {
    return <p role="status" data-testid="norma-review-empty" className="rounded border p-3 text-sm">That call is no longer waiting for review.</p>;
  }
  const mark = (row: NormaReviewRow) =>
    startTransition(async () => {
      const result = await markNormaRequestReviewed(row.propertyId, row.id);
      if (result.ok || (!result.ok && result.code === "not_waiting")) {
        setErrors((prev) => ({ ...prev, [row.id]: "" }));
        router.refresh();
      } else {
        setErrors((prev) => ({ ...prev, [row.id]: "Could not mark this call reviewed. Please retry." }));
      }
    });
  return (
    <section aria-label="Calls needing review" data-testid="norma-review" className="space-y-2">
      {rows.map((row) => (
        <article key={row.id} data-testid={`norma-review-${row.id}`} {...(row.selected ? { "data-selected": "true" } : {})} className={`space-y-1 rounded border p-3 text-sm ${row.selected ? "ring-2 ring-sky-500" : ""}`}>
          <p className="font-medium">{row.address}</p>
          <p className="text-muted-foreground">{row.summary ?? row.outcome ?? "This call did not end clearly."}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={() => mark(row)}>Mark reviewed</Button>
            <a className="text-xs underline" href={`/leads/${row.propertyId}`} target="_blank" rel="noopener noreferrer">Open lead</a>
            {errors[row.id] ? <span role="alert" className="text-xs text-destructive">{errors[row.id]}</span> : null}
          </div>
        </article>
      ))}
    </section>
  );
}
