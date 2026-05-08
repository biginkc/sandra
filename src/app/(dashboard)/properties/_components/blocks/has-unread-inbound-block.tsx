"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

type Block = Extract<FilterBlock, { kind: "has_unread_inbound" }>;

export default function HasUnreadInboundBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="Has Unread Inbound" onRemove={onRemove}>
      <RadioGroup
        value={block.tri}
        onValueChange={(v) => onChange({ tri: v as "any" | "yes" | "no" })}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="any" id="hui-any" />
          <Label htmlFor="hui-any">Any</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="yes" id="hui-yes" />
          <Label htmlFor="hui-yes">Yes</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="no" id="hui-no" />
          <Label htmlFor="hui-no">No</Label>
        </div>
      </RadioGroup>
    </BlockShell>
  );
}
