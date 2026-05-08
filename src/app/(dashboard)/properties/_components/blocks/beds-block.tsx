"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { Input } from "@/components/ui/input";

type Block = Extract<FilterBlock, { kind: "beds" }>;

export default function BedsBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="Beds" onRemove={onRemove}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={0}
          placeholder="Min"
          value={block.range.min ?? ""}
          onChange={(e) =>
            onChange({
              range: {
                ...block.range,
                min: e.target.value === "" ? null : Number(e.target.value),
              },
            })
          }
          aria-label="Minimum beds"
        />
        <span className="text-muted-foreground text-sm">–</span>
        <Input
          type="number"
          min={0}
          placeholder="Max"
          value={block.range.max ?? ""}
          onChange={(e) =>
            onChange({
              range: {
                ...block.range,
                max: e.target.value === "" ? null : Number(e.target.value),
              },
            })
          }
          aria-label="Maximum beds"
        />
      </div>
    </BlockShell>
  );
}
