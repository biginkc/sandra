"use client";

import { useRef, useState } from "react";
import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { BlockKind } from "@/lib/prospects/filter-schema";

export const BLOCK_PICKER_GROUPS = [
  {
    group: "General",
    items: [
      { kind: "list" as const, label: "List" },
      { kind: "tag" as const, label: "Tag" },
      { kind: "list_count" as const, label: "List Count" },
      { kind: "vacancy" as const, label: "Vacancy" },
      { kind: "cass" as const, label: "CASS" },
      { kind: "outreach_dispo" as const, label: "Outreach Disposition" },
      { kind: "source" as const, label: "Source" },
    ],
  },
  {
    group: "Property",
    items: [
      { kind: "beds" as const, label: "Beds" },
      { kind: "baths" as const, label: "Baths" },
      { kind: "year_built" as const, label: "Year Built" },
      { kind: "state" as const, label: "State" },
      { kind: "market" as const, label: "Market" },
    ],
  },
  {
    group: "Owner",
    items: [{ kind: "absentee" as const, label: "Absentee" }],
  },
  {
    group: "Value & Equity",
    items: [
      { kind: "estimated_value" as const, label: "Estimated Value" },
      { kind: "equity_pct" as const, label: "Equity %" },
    ],
  },
  {
    group: "Status & Engagement",
    items: [
      { kind: "pipeline_status" as const, label: "Pipeline Status" },
      { kind: "engagement" as const, label: "Engagement" },
      { kind: "assignee" as const, label: "Assignee" },
      { kind: "created_date" as const, label: "Created Date" },
    ],
  },
  {
    group: "Schema-audit additions",
    items: [
      { kind: "has_unread_inbound" as const, label: "Has Unread Inbound" },
      { kind: "needs_human_attention" as const, label: "Needs Human Attention" },
      { kind: "has_open_tasks" as const, label: "Has Open Tasks" },
      { kind: "motivation_level" as const, label: "Motivation Level" },
    ],
  },
] as const;

export type AddBlockPickerProps = {
  open: boolean;
  onClose: () => void;
  onSelect: (kind: BlockKind) => void;
  alreadyConfiguredKinds?: Set<BlockKind>;
};

/**
 * Inner component — mounted/unmounted based on `open` via the outer shell.
 * This means local state (q) always starts fresh when the picker opens,
 * and no effect-based reset is needed.
 */
function AddBlockPickerInner({
  onClose,
  onSelect,
}: Pick<AddBlockPickerProps, "onClose" | "onSelect">) {
  const [q, setQ] = useState("");
  // autoFocus on the input handles focusing in both browser and jsdom.
  // We keep a ref for any external callers that need the element.
  const inputRef = useRef<HTMLInputElement | null>(null);

  const needle = q.trim().toLowerCase();
  const filtered: ReadonlyArray<{
    group: string;
    items: ReadonlyArray<{ kind: BlockKind; label: string }>;
  }> = needle
    ? BLOCK_PICKER_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((it) =>
          it.label.toLowerCase().includes(needle),
        ),
      })).filter((g) => g.items.length > 0)
    : BLOCK_PICKER_GROUPS;

  return (
    <div
      role="dialog"
      aria-label="Add filter block"
      className="absolute inset-0 z-10 flex flex-col bg-popover"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b p-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          onClick={onClose}
        >
          <ArrowLeftIcon />
        </Button>
        <input
          ref={inputRef}
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          placeholder="Search filters…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.map((g) => (
          <div key={g.group} className="mb-4">
            <div className="px-2 py-1 text-xs uppercase tracking-wide text-muted-foreground">
              {g.group}
            </div>
            {g.items.map((it) => (
              <button
                key={it.kind}
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                onClick={() => onSelect(it.kind)}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Outer shell — conditionally mounts AddBlockPickerInner.
 * Mounting/unmounting ensures q always resets to "" when picker opens,
 * without needing a separate effect to reset state.
 */
export function AddBlockPicker({
  open,
  onClose,
  onSelect,
}: AddBlockPickerProps) {
  if (!open) return null;
  return <AddBlockPickerInner onClose={onClose} onSelect={onSelect} />;
}
