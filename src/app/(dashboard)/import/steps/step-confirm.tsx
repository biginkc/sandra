"use client";

import { useEffect, useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { listSequences } from "@/app/(dashboard)/sequences/actions";

import type { WizardAction, WizardState } from "../wizard";

type SequenceOption = { id: string; name: string };

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepConfirm({ state, dispatch }: Props) {
  const summary = state.summary;
  const validRows = summary?.validRows ?? 0;
  const estimatedCassCost = (validRows * 0.03).toFixed(2);

  const [sequences, setSequences] = useState<SequenceOption[]>([]);
  useEffect(() => {
    listSequences().then((result) => {
      if (result.ok) {
        setSequences(
          result.data
            .filter((s) => s.active && !s.archived_at)
            .map((s) => ({ id: s.id, name: s.name })),
        );
      }
    });
  }, []);

  // The "Also request skip-trace" checkbox lived here in V1 and rode the
  // legacy after()-callback path. With the workflow runner the action no
  // longer holds a user session at completion time, which the existing
  // requestSkipTrace() needs for the admin/VA approval branching. Easiest
  // fix is to surface the prompt on the StepDone screen instead — once
  // the workflow finishes, the user is still in the wizard and a one-
  // click "skip-trace these N properties" button works the same. Tracked
  // as a follow-up; for now skip-trace happens manually from /properties.

  return (
    <Card>
      <CardHeader>
        <CardTitle>Ready to import</CardTitle>
        <CardDescription>
          Review the summary and click Start Import to begin.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Row label="File" value={state.filename ?? "—"} />
        <Row label="Source" value={state.source ?? "—"} />
        <Row label="Market" value={state.market ?? "—"} />
        <Row
          label="Rows to ingest"
          value={`${validRows} valid of ${summary?.totalRows ?? 0} total`}
        />
        <Row
          label="CASS enrichment"
          value={`Will auto-trigger after ingest · est. $${estimatedCassCost} (not charged today; integration lands in a future session)`}
        />
        <Row
          label="Agent enrichment"
          value="Off by default. Trigger from property detail or batch action after ingest."
        />

        <div className="flex items-start gap-3 pt-1">
          <input
            id="sms-consent"
            type="checkbox"
            checked={state.smsConsent}
            onChange={(e) =>
              dispatch({ type: "SET_SMS_CONSENT", smsConsent: e.target.checked })
            }
            className="mt-0.5 h-4 w-4 cursor-pointer accent-primary"
          />
          <Label htmlFor="sms-consent" className="text-sm leading-snug cursor-pointer">
            I attest that all contacts in this import have given written consent
            to receive SMS messages, and that I have records to support this attestation.
          </Label>
        </div>

        {state.smsConsent && (
          <div className="flex flex-col gap-1.5 pl-7">
            <Label htmlFor="sequence-picker" className="text-sm">
              Auto-enroll in sequence <span className="text-muted-foreground">(optional)</span>
            </Label>
            <select
              id="sequence-picker"
              value={state.sequenceId ?? ""}
              onChange={(e) =>
                dispatch({
                  type: "SET_SEQUENCE_ID",
                  sequenceId: e.target.value || null,
                })
              }
              className="border-input bg-background text-sm rounded-md border px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">None — don&apos;t auto-enroll</option>
              {sequences.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
      <div className="text-muted-foreground min-w-[140px] text-sm">
        {label}
      </div>
      <div className="text-sm">{value}</div>
    </div>
  );
}
