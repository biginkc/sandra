"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";

type Block = Extract<FilterBlock, { kind: "vacancy" }>;

export default function VacancyBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  return (
    <BlockShell label="Vacancy" onRemove={onRemove}>
      <RadioGroup
        value={block.tri}
        onValueChange={(v) => onChange({ tri: v as "any" | "yes" | "no" })}
      >
        <div className="flex items-center gap-2">
          <RadioGroupItem value="any" id="vac-any" />
          <Label htmlFor="vac-any">Any</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="yes" id="vac-yes" />
          <Label htmlFor="vac-yes">Yes (vacant)</Label>
        </div>
        <div className="flex items-center gap-2">
          <RadioGroupItem value="no" id="vac-no" />
          <Label htmlFor="vac-no">No (occupied)</Label>
        </div>
      </RadioGroup>
    </BlockShell>
  );
}
