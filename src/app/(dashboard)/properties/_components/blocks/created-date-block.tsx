"use client";

import type { FilterBlock, DateMode } from "@/lib/prospects/filter-schema";
import { BlockShell } from "./_block-shell";
import { Input } from "@/components/ui/input";

type Block = Extract<FilterBlock, { kind: "created_date" }>;

export default function CreatedDateBlock({
  block,
  onChange,
  onRemove,
}: {
  block: Block;
  onChange: (patch: Partial<Block>) => void;
  onRemove: () => void;
}) {
  const mode = block.date.mode;

  function setMode(newMode: DateMode["mode"]) {
    if (newMode === "fixed") {
      onChange({ date: { mode: "fixed", from: null, to: null } });
    } else {
      onChange({ date: { mode: newMode, days: 30 } });
    }
  }

  return (
    <BlockShell label="Created Date" onRemove={onRemove}>
      <select
        className="text-xs border rounded px-1 py-0.5 mb-2 w-full"
        value={mode}
        onChange={(e) => setMode(e.target.value as DateMode["mode"])}
        aria-label="Date mode"
      >
        <option value="fixed">Fixed range</option>
        <option value="since">Since N days ago</option>
        <option value="prior">Prior N days</option>
      </select>

      {mode === "fixed" && (
        <div className="flex flex-col gap-2">
          <Input
            type="date"
            value={(block.date as Extract<DateMode, { mode: "fixed" }>).from ?? ""}
            onChange={(e) =>
              onChange({
                date: {
                  ...(block.date as Extract<DateMode, { mode: "fixed" }>),
                  from: e.target.value || null,
                },
              })
            }
            aria-label="From date"
          />
          <Input
            type="date"
            value={(block.date as Extract<DateMode, { mode: "fixed" }>).to ?? ""}
            onChange={(e) =>
              onChange({
                date: {
                  ...(block.date as Extract<DateMode, { mode: "fixed" }>),
                  to: e.target.value || null,
                },
              })
            }
            aria-label="To date"
          />
        </div>
      )}

      {(mode === "since" || mode === "prior") && (
        <Input
          type="number"
          min={1}
          placeholder="Days"
          value={(block.date as Extract<DateMode, { mode: "since" } | { mode: "prior" }>).days}
          onChange={(e) =>
            onChange({
              date: {
                mode,
                days: Number(e.target.value) || 0,
              },
            })
          }
          aria-label="Number of days"
        />
      )}
    </BlockShell>
  );
}
