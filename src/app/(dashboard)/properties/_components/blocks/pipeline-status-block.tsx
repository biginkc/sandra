"use client";

import { useEffect } from "react";
import type { FilterBlock } from "@/lib/prospects/filter-schema";
import {
  PROPERTY_STATUS_LABELS,
  systemLabel,
} from "@/lib/presentation/system-labels";
import { BlockShell, CombinatorSelect, useBlockOptions } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "pipeline_status" }>;

// Per SPEC §114: when a pipeline_status block is first added (values=[]),
// auto-prefill "prospect" so the user sees a useful default immediately.
export default function PipelineStatusBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  const { pipelineStatuses } = useBlockOptions();

  // Auto-prefill "prospect" on first mount if no values are selected yet.
  useEffect(() => {
    if (block.values.length === 0) {
      onChange({ values: ["prospect"] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(v: string) {
    const next = block.values.includes(v)
      ? block.values.filter((x) => x !== v)
      : [...block.values, v];
    onChange({ values: next });
  }

  return (
    <BlockShell label="Pipeline Status" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {pipelineStatuses.map((s) => (
          <label
            key={s}
            className="flex items-center gap-2 text-sm cursor-pointer"
          >
            <input
              type="checkbox"
              checked={block.values.includes(s)}
              onChange={() => toggle(s)}
            />
            {systemLabel(PROPERTY_STATUS_LABELS, s)}
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
