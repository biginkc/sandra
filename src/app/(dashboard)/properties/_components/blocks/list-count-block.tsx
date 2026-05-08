"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { Input } from "@/components/ui/input";

type Block = Extract<FilterBlock, { kind: "list_count" }>;

// v1: min/max number inputs — no Slider component in Sandra's UI library.
export default function ListCountBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="List Count" onRemove={onRemove}>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={1}
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
          aria-label="Minimum list count"
        />
        <span className="text-muted-foreground text-sm">–</span>
        <Input
          type="number"
          min={1}
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
          aria-label="Maximum list count"
        />
      </div>
    </BlockShell>
  );
}
