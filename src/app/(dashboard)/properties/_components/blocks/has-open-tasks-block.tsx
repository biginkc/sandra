"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

type Block = Extract<FilterBlock, { kind: "has_open_tasks" }>;

export default function HasOpenTasksBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="Has Open Tasks" onRemove={onRemove}>
      <RadioGroup
        value={block.tri}
        onValueChange={(v) => onChange({ tri: v as "any" | "yes" | "no" })}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="any" id="hot-any" />
          <Label htmlFor="hot-any">Any</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="yes" id="hot-yes" />
          <Label htmlFor="hot-yes">Yes</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="no" id="hot-no" />
          <Label htmlFor="hot-no">No</Label>
        </div>
      </RadioGroup>
    </BlockShell>
  );
}
