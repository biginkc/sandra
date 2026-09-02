"use client";

import type { FilterBlock } from "@/lib/prospects/filter-schema";
import {
  teamMemberPrimaryLabel,
  teamMemberSecondaryLabel,
} from "@/lib/auth/team-member";
import { BlockShell, CombinatorSelect, useBlockOptions } from "./_block-shell";

type Block = Extract<FilterBlock, { kind: "assignee" }>;

// "unassigned" is a sentinel value handled by the translator (Plan 04 case 18).
const UNASSIGNED = "unassigned";

export default function AssigneeBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  const { assignees } = useBlockOptions();

  function toggle(v: string) {
    const next = block.values.includes(v)
      ? block.values.filter((x) => x !== v)
      : [...block.values, v];
    onChange({ values: next });
  }

  return (
    <BlockShell label="Assignee" onRemove={onRemove}>
      <CombinatorSelect
        value={block.combinator}
        onChange={(c) => onChange({ combinator: c })}
      />
      <div className="flex flex-col gap-1 mt-1">
        {/* Unassigned pseudo-option — sentinel value "unassigned" */}
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={block.values.includes(UNASSIGNED)}
            onChange={() => toggle(UNASSIGNED)}
          />
          Unassigned
        </label>
        {assignees.map((a) => (
          <label
            key={a.id}
            className="flex items-center gap-2 text-sm cursor-pointer"
          >
            <input
              type="checkbox"
              checked={block.values.includes(a.id)}
              onChange={() => toggle(a.id)}
            />
            <span className="flex min-w-0 flex-col">
              <span>{teamMemberPrimaryLabel(a)}</span>
              {teamMemberSecondaryLabel(a) ? (
                <span className="text-muted-foreground text-xs">
                  {teamMemberSecondaryLabel(a)}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </div>
    </BlockShell>
  );
}
