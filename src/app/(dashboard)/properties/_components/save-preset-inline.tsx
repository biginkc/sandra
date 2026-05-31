"use client";

import { useState, useTransition } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { createSavedFilter } from "@/app/(dashboard)/properties/_actions/saved-filters";
import type { BlockStack } from "@/lib/prospects/filter-schema";

export type SavePresetInlineProps = {
  orgId: string;
  currentBlocks: BlockStack;
};

/**
 * Inline "Save as new preset…" control for the drawer footer.
 *
 * Renders a checkbox toggle. When checked, reveals a name input + Save button.
 * Clicking Save calls createSavedFilter server action, shows a toast on
 * success/failure, then router.refresh() to repaint the Quick Filters bar
 * (per D-13 / D-15).
 *
 * Plan 09 inserts this component into the drawer footer below the count CTA.
 */
export function SavePresetInline({ orgId, currentBlocks }: SavePresetInlineProps) {
  const [enabled, setEnabled] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const onSave = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Please enter a preset name.");
      return;
    }
    startTransition(async () => {
      const result = await createSavedFilter({
        orgId,
        name: trimmed,
        filtersJson: { v: 1, blocks: currentBlocks },
      });
      if (result.ok) {
        toast.success(`Saved preset "${trimmed}".`);
        setEnabled(false);
        setName("");
        router.refresh();
      } else {
        toast.error(`Failed to save preset: ${result.error.message}`);
      }
    });
  };

  return (
    <div className="border-t pt-3 mt-3" data-save-preset-inline>
      <label className="flex items-center gap-2 cursor-pointer select-none">
        <input
          data-testid="save-preset-toggle"
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-input accent-primary"
        />
        <span className="text-sm">Save as new preset…</span>
      </label>
      {enabled ? (
        <div className="flex gap-2 mt-2">
          <Input
            placeholder="Preset name"
            value={name}
            onChange={(e) => setName((e.target as HTMLInputElement).value)}
            maxLength={100}
          />
          <Button
            size="sm"
            onClick={onSave}
            disabled={pending || !name.trim()}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
