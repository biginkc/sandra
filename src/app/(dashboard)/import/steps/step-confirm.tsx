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
import { isLineTypeLookupConfigured } from "../actions";
import { TELNYX_LOOKUP_COST_USD } from "@/lib/line-type-lookup/telnyx";
import { cn } from "@/lib/utils";

import type { WizardAction, WizardState } from "../wizard";

type SequenceOption = { id: string; name: string };

type Props = {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  /** Distinct phone numbers in the file that have no line type —
   *  computed by the wizard with the same helper the workflow's
   *  classification step uses. Drives the interstitial below. */
  unlabeledPhoneCount: number;
};

export function StepConfirm({ state, dispatch, unlabeledPhoneCount }: Props) {
  const summary = state.summary;
  const validRows = summary?.validRows ?? 0;
  const estimatedCassCost = (validRows * 0.03).toFixed(2);

  const [sequences, setSequences] = useState<SequenceOption[]>([]);
  // null = still checking; the Classify choice is only offered once the
  // lookup is confirmed configured (offering it and silently dropping
  // the numbers was the failure mode).
  const [telnyxConfigured, setTelnyxConfigured] = useState<boolean | null>(
    null,
  );
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
    isLineTypeLookupConfigured().then(setTelnyxConfigured);
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

        {unlabeledPhoneCount > 0 && (
          <LineTypeInterstitial
            count={unlabeledPhoneCount}
            choice={state.classifyLineTypes}
            telnyxConfigured={telnyxConfigured}
            onChoose={(classifyLineTypes) =>
              dispatch({ type: "SET_CLASSIFY_LINE_TYPES", classifyLineTypes })
            }
          />
        )}

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

/**
 * Pre-ingest interstitial for the hard rule: phone numbers with no line
 * type are never saved to the database. The operator must explicitly
 * pick Classify (Telnyx lookup, ~$0.003/number) or Skip — the wizard's
 * Start import button stays disabled until a choice is made, and the
 * choice rides the import job's input params.
 */
function LineTypeInterstitial({
  count,
  choice,
  telnyxConfigured,
  onChoose,
}: {
  count: number;
  choice: boolean | null;
  /** null while the config check is in flight. */
  telnyxConfigured: boolean | null;
  onChoose: (classify: boolean) => void;
}) {
  const estimatedCost = (count * TELNYX_LOOKUP_COST_USD).toFixed(2);
  const classifyUnavailable = telnyxConfigured === false;
  return (
    <div className="rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
      <div className="text-sm font-semibold">
        {count.toLocaleString()} phone{" "}
        {count === 1 ? "number has" : "numbers have"} no line type
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        Phone numbers without a line type (mobile or landline) are{" "}
        <span className="font-semibold">not saved to the database</span>.
        Classify them via Telnyx (~${estimatedCost}), or skip — skipped
        numbers are dropped from this import.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <ChoiceOption
          id="classify-line-types"
          checked={choice === true}
          disabled={classifyUnavailable}
          onSelect={() => onChoose(true)}
          title={`Classify via Telnyx (~$${estimatedCost})`}
          detail={
            classifyUnavailable
              ? "Unavailable — TELNYX_API_KEY is not configured. Add it to Sandra's environment to enable paid classification."
              : "Looks up each number's carrier; confirmed mobiles and landlines are saved with their type."
          }
        />
        <ChoiceOption
          id="skip-line-types"
          checked={choice === false}
          onSelect={() => onChoose(false)}
          title="Skip — drop unlabeled numbers"
          detail="These numbers are NOT saved. Contacts still import with their name, email, and any labeled phones."
        />
      </div>
    </div>
  );
}

function ChoiceOption({
  id,
  checked,
  disabled = false,
  onSelect,
  title,
  detail,
}: {
  id: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        "border-border bg-background flex cursor-pointer items-start gap-3 rounded-md border p-3",
        checked && "border-primary ring-primary/30 ring-2",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        id={id}
        type="radio"
        name="line-type-choice"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-muted-foreground text-xs">{detail}</span>
      </span>
    </label>
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
