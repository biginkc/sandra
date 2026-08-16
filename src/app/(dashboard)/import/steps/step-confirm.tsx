"use client";

import { useEffect, useState } from "react";

import { listSequences } from "@/app/(dashboard)/sequences/actions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { sumEnabledImportServiceEstimates } from "@/lib/csv/import-pricing";

import type { WizardAction, WizardState } from "../wizard";

type SequenceOption = { id: string; name: string };

export function StepConfirm({
  state,
  dispatch,
  unlabeledPhoneCount,
}: {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  unlabeledPhoneCount: number;
}) {
  const [sequences, setSequences] = useState<SequenceOption[]>([]);
  useEffect(() => {
    listSequences().then((result) => {
      if (result.ok) {
        setSequences(
          result.data
            .filter((sequence) => sequence.active && !sequence.archived_at)
            .map((sequence) => ({ id: sequence.id, name: sequence.name })),
        );
      }
    });
  }, []);

  const validRows = state.summary?.validRows ?? 0;
  const dncRows = state.preflight?.dnc ?? 0;
  const eligibleRows = Math.max(0, validRows - dncRows);
  const maxCharge = sumEnabledImportServiceEstimates({
    requestCass: state.requestCass,
    classifyLineTypes: state.classifyLineTypes,
    requestSkipTrace: false,
    cassEligible: eligibleRows,
    lineTypeEligible: unlabeledPhoneCount,
    skipTraceEligible: 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Confirm import</CardTitle>
        <CardDescription>Review the exact dataset and choices Sandra will use.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="divide-border border-border divide-y rounded-xl border px-4">
          <Row label="File" value={state.filename ?? "—"} />
          <Row label="Source" value={state.source ?? "—"} />
          <Row label="Market" value={state.market ?? "—"} />
          <Row label="Rows to import" value={`${validRows.toLocaleString()} Prospects`} />
          <Row label="Do Not Contact" value={`${dncRows.toLocaleString()} locked Prospects`} />
          <Row
            label="Paid services"
            value={[
              state.requestCass ? "Address verification" : null,
              state.classifyLineTypes ? "Line-type classification" : null,
            ].filter(Boolean).join(", ") || "None"}
          />
          <Row label="Maximum estimated charge" value={`$${maxCharge.toFixed(2)}`} />
          <Row
            label="List assignment"
            value={state.listName ? `Assign to “${state.listName}” and verify completion` : "None"}
          />
        </div>

        <div className="flex items-start gap-3">
          <input
            id="sms-consent"
            type="checkbox"
            checked={state.smsConsent}
            onChange={(event) =>
              dispatch({ type: "SET_SMS_CONSENT", smsConsent: event.target.checked })
            }
            className="mt-0.5 size-4 accent-primary"
          />
          <Label htmlFor="sms-consent" className="cursor-pointer text-sm leading-snug">
            I attest that every contact in this file has given written SMS consent.
            Without this, no SMS sequence can be enrolled from this import.
          </Label>
        </div>

        {state.smsConsent && (
          <div className="flex flex-col gap-1.5 pl-7">
            <Label htmlFor="sequence-picker">Auto-enroll in sequence (optional)</Label>
            <select
              id="sequence-picker"
              value={state.sequenceId ?? ""}
              onChange={(event) =>
                dispatch({ type: "SET_SEQUENCE_ID", sequenceId: event.target.value || null })
              }
              className="border-input bg-background rounded-md border px-3 py-2 text-sm"
            >
              <option value="">None — don&apos;t auto-enroll</option>
              {sequences.map((sequence) => (
                <option key={sequence.id} value={sequence.id}>{sequence.name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="bg-muted rounded-xl p-4 text-sm leading-relaxed">
          Destination is Prospects. Nothing becomes a Lead from this import —
          you&apos;ll review and promote deliberately afterward.
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}
