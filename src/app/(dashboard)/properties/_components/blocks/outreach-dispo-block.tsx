"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import { BlockShell, CombinatorSelect, useBlockOptions } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "outreach_dispo" }>;

const OUTREACH_DISPO_LABELS: Record<string, string> = {
  wrong_number: "Wrong number",
  bad_number: "Bad / disconnected number",
  not_interested: "Not interested",
  opted_out: "SMS opted out",
  dnc: "Do not call",
  nurture: "Follow up",
  callback_requested: "Callback requested",
  needs_sequence: "Needs sequence",
};

export default function OutreachDispoBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  const { outreachDispos } = useBlockOptions();

  function toggle(v: string) {
    const next = block.values.includes(v)
      ? block.values.filter((x) => x !== v)
      : [...block.values, v];
    onChange({ values: next });
  }

  return (
    <BlockShell label="Outreach Disposition" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {outreachDispos.map((d) => (
          <label key={d} className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={block.values.includes(d)}
              onChange={() => toggle(d)}
            />
            {OUTREACH_DISPO_LABELS[d] ?? d}
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
