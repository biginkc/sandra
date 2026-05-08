"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

type Block = Extract<FilterBlock, { kind: "needs_human_attention" }>;

export default function NeedsHumanAttentionBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="Needs Human Attention" onRemove={onRemove}>
      <RadioGroup
        value={block.tri}
        onValueChange={(v) => onChange({ tri: v as "any" | "yes" | "no" })}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="any" id="nha-any" />
          <Label htmlFor="nha-any">Any</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="yes" id="nha-yes" />
          <Label htmlFor="nha-yes">Yes</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="no" id="nha-no" />
          <Label htmlFor="nha-no">No</Label>
        </div>
      </RadioGroup>
    </BlockShell>
  );
}
