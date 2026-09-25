"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";

import { setJevThreshold, type JevThresholdRow } from "./actions";

const OUTCOME_LABELS: Record<JevThresholdRow["outcome"], string> = {
  new_lead: "New lead",
  wrong_number: "Wrong number",
  not_interested: "Not interested",
  nurture: "Nurture",
  opted_out: "Opted out",
};

function OutcomeRow({
  orgId,
  row,
  onSaved,
}: {
  orgId: string;
  row: JevThresholdRow;
  onSaved: (next: JevThresholdRow) => void;
}) {
  const [value, setValue] = useState(String(row.minConfidence));
  const [pending, startTransition] = useTransition();

  const onSave = () => {
    const minConfidence = Number(value);
    startTransition(async () => {
      const result = await callAction(
        setJevThreshold({
          orgId,
          outcome: row.outcome,
          minConfidence,
          expectedVersion: row.version,
        }),
        {
          successMessage: `${OUTCOME_LABELS[row.outcome]} threshold saved`,
          fallbackMessage: "Could not save threshold",
        },
      );
      if (result.ok) {
        onSaved({ outcome: row.outcome, minConfidence: result.data.minConfidence, version: result.data.version });
      }
    });
  };

  const dirty = Number(value) !== row.minConfidence;

  return (
    <tr data-testid={`jev-threshold-row-${row.outcome}`}>
      <td className="py-2 pr-4 text-sm font-medium">{OUTCOME_LABELS[row.outcome]}</td>
      <td className="py-2 pr-4">
        <Input
          type="number"
          min={0}
          max={1}
          step={0.001}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-28"
          data-testid={`jev-threshold-input-${row.outcome}`}
        />
      </td>
      <td className="py-2 pr-4 text-xs text-muted-foreground">
        {row.version === 0 ? "not yet configured" : `v${row.version}`}
      </td>
      <td className="py-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || !dirty}
          onClick={onSave}
          data-testid={`jev-threshold-save-${row.outcome}`}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </td>
    </tr>
  );
}

export function JevThresholdsForm({
  orgId,
  initialRows,
}: {
  orgId: string;
  initialRows: JevThresholdRow[];
}) {
  const [rows, setRows] = useState(initialRows);

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Native TypeSafe confidence must be at or above this value for Jev to apply the outcome
        automatically. Defaults are provisional operational choices, not claimed accuracy.
        DNC and unclear outcomes, and any missing or invalid confidence, are always routed to a
        human regardless of threshold. Edits take effect on the next classification — no
        deployment required, and never applied retroactively to past decisions.
      </p>
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b text-xs uppercase text-muted-foreground">
            <th className="py-2 pr-4">Outcome</th>
            <th className="py-2 pr-4">Min. confidence</th>
            <th className="py-2 pr-4">Version</th>
            <th className="py-2" />
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <OutcomeRow
              key={row.outcome}
              orgId={orgId}
              row={row}
              onSaved={(next) =>
                setRows((prev) => prev.map((r) => (r.outcome === next.outcome ? next : r)))
              }
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
