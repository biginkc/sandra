"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell, CombinatorSelect, useBlockOptions } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "tag" }>;

export default function TagBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  // tags are already pre-filtered to category='custom' by the context provider (Plan 09)
  const { tags } = useBlockOptions();

  function toggle(id: string) {
    const next = block.values.includes(id)
      ? block.values.filter((v) => v !== id)
      : [...block.values, id];
    onChange({ values: next });
  }

  return (
    <BlockShell label="Tag" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {tags.map((t) => (
          <label key={t.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={block.values.includes(t.id)}
              onChange={() => toggle(t.id)}
            />
            {t.name}
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
