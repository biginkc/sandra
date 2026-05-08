"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell, CombinatorSelect, useBlockOptions } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "motivation_level" }>;

export default function MotivationLevelBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  const { motivationLevels } = useBlockOptions();

  function toggle(v: string) {
    const next = block.values.includes(v)
      ? block.values.filter((x) => x !== v)
      : [...block.values, v];
    onChange({ values: next });
  }

  return (
    <BlockShell label="Motivation Level" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {motivationLevels.map((m) => (
          <label key={m} className="flex items-center gap-2 text-sm cursor-pointer capitalize">
            <input
              type="checkbox"
              checked={block.values.includes(m)}
              onChange={() => toggle(m)}
            />
            {m}
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
