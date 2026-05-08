"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

type Block = Extract<FilterBlock, { kind: "absentee" }>;

export default function AbsenteeBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="Absentee Owner" onRemove={onRemove}>
      <RadioGroup
        value={block.tri}
        onValueChange={(v) => onChange({ tri: v as "any" | "yes" | "no" })}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="any" id="abs-any" />
          <Label htmlFor="abs-any">Any</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="yes" id="abs-yes" />
          <Label htmlFor="abs-yes">Yes (absentee)</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="no" id="abs-no" />
          <Label htmlFor="abs-no">No (owner-occupied)</Label>
        </div>
      </RadioGroup>
    </BlockShell>
  );
}
