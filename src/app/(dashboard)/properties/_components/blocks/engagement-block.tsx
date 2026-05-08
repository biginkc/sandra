"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell, CombinatorSelect } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "engagement" }>;
type EngagementValue = Block["values"][number];

// Per SPEC + CONTEXT specifics line 166: 4 hardcoded buckets (NOT from BlockOptions).
const ENGAGEMENT_BUCKETS: Array<{ value: EngagementValue; label: string }> = [
  { value: "never_contacted", label: "Never contacted" },
  { value: "attempted", label: "Attempted" },
  { value: "replied", label: "Replied" },
  { value: "opted_out", label: "Opted out" },
];

export default function EngagementBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  function toggle(v: EngagementValue) {
    const next = block.values.includes(v)
      ? block.values.filter((x) => x !== v)
      : [...block.values, v];
    onChange({ values: next });
  }

  return (
    <BlockShell label="Engagement" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {ENGAGEMENT_BUCKETS.map(({ value, label }) => (
          <label key={value} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={block.values.includes(value)}
              onChange={() => toggle(value)}
            />
            {label}
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
