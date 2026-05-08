"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell, CombinatorSelect, useBlockOptions } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "list" }>;

export default function ListBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  const { lists } = useBlockOptions();

  function toggle(id: string) {
    const next = block.values.includes(id)
      ? block.values.filter((v) => v !== id)
      : [...block.values, id];
    onChange({ values: next });
  }

  return (
    <BlockShell label="List" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {lists.map((l) => (
          <label key={l.id} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={block.values.includes(l.id)}
              onChange={() => toggle(l.id)}
            />
            {l.name}
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
