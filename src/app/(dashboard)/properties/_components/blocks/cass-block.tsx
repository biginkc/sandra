"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import {
  CASS_STATUS_LABELS,
  systemLabel,
} from "@/lib/presentation/system-labels";
import { BlockShell, CombinatorSelect, useBlockOptions } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "cass" }>;

export default function CassBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  const { cassStatuses } = useBlockOptions();

  function toggle(v: string) {
    const next = block.values.includes(v)
      ? block.values.filter((x) => x !== v)
      : [...block.values, v];
    onChange({ values: next });
  }

  return (
    <BlockShell label="CASS" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {cassStatuses.map((s) => (
          <label key={s} className="flex items-center gap-2 text-sm cursor-pointer capitalize">
            <input
              type="checkbox"
              checked={block.values.includes(s)}
              onChange={() => toggle(s)}
            />
            {systemLabel(CASS_STATUS_LABELS, s)}
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
