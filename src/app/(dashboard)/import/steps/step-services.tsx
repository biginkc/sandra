"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  IMPORT_SERVICE_PRICING,
  estimateMaxCostUsd,
  type ImportPaidServiceId,
} from "@/lib/csv/import-pricing";

import type { WizardAction, WizardState } from "../wizard";

type Props = {
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
  unlabeledPhoneCount: number;
};

export function StepServices({ state, dispatch, unlabeledPhoneCount }: Props) {
  const validRows = state.summary?.validRows ?? state.preflight?.ready ?? 0;
  const eligibleRows = Math.max(0, validRows - (state.preflight?.dnc ?? 0));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Optional services</CardTitle>
        <CardDescription>
          Everything here is off by default and runs during this import if turned on.
          Nothing paid runs without the price shown and your explicit switch. DNC
          records are never eligible.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ServiceOption
          id="cass"
          enabled={state.requestCass}
          eligible={eligibleRows}
          unavailable={IMPORT_SERVICE_PRICING.cass.unavailableReason}
          onChange={(enabled) => dispatch({ type: "SET_REQUEST_CASS", requestCass: enabled })}
        />
        <ServiceOption
          id="line_type"
          enabled={state.classifyLineTypes}
          eligible={unlabeledPhoneCount}
          disabled={unlabeledPhoneCount === 0}
          unavailable={
            unlabeledPhoneCount === 0
              ? "No unlabeled phone numbers need classification."
              : IMPORT_SERVICE_PRICING.line_type.unavailableReason
          }
          onChange={(enabled) =>
            dispatch({ type: "SET_CLASSIFY_LINE_TYPES", classifyLineTypes: enabled })
          }
          detail="Unlabeled numbers are never saved — without this, they are dropped and reported."
        />
        <ServiceOption
          id="skip_trace"
          enabled={false}
          eligible={eligibleRows}
          disabled
          unavailable={IMPORT_SERVICE_PRICING.skip_trace.unavailableReason}
          onChange={() => undefined}
        />
      </CardContent>
    </Card>
  );
}

function ServiceOption({
  id,
  enabled,
  eligible,
  disabled = false,
  unavailable,
  detail,
  onChange,
}: {
  id: ImportPaidServiceId;
  enabled: boolean;
  eligible: number;
  disabled?: boolean;
  unavailable?: string;
  detail?: string;
  onChange: (enabled: boolean) => void;
}) {
  const pricing = IMPORT_SERVICE_PRICING[id];
  const estimate = estimateMaxCostUsd(pricing.unitPriceUsd, eligible);
  const priceLine = pricing.unitPriceUsd == null
    ? unavailable ?? "Price unavailable"
    : `$${pricing.unitPriceUsd.toFixed(3)} per record × ${eligible.toLocaleString()} eligible records = max estimated $${(estimate ?? 0).toFixed(2)} · runs during this import`;

  return (
    <label
      htmlFor={`service-${id}`}
      className="border-border flex cursor-pointer items-start gap-3 rounded-xl border p-4 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60"
    >
      <input
        id={`service-${id}`}
        type="checkbox"
        checked={enabled}
        disabled={disabled || !pricing.configured}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 size-4 accent-primary"
      />
      <span className="flex flex-col gap-1">
        <Label className="text-sm font-semibold">{pricing.label}</Label>
        <span className="text-muted-foreground text-xs">{priceLine}</span>
        {(detail || unavailable) && (
          <span className="text-muted-foreground text-xs">{detail ?? unavailable}</span>
        )}
      </span>
    </label>
  );
}
