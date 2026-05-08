"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { Input } from "@/components/ui/input";

type Block = Extract<FilterBlock, { kind: "baths" }>;

export default function BathsBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="Baths" onRemove={onRemove}>
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
          aria-label="Minimum baths"
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
          aria-label="Maximum baths"
        />
      </div>
    </BlockShell>
  );
}
