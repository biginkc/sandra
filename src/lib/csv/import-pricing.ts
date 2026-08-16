import {
  IMPORT_CASS_VERIFIED_COST_USD,
  TELNYX_LOOKUP_COST_USD,
} from "@/lib/provider-pricing";

export type ImportPaidServiceId = "cass" | "line_type" | "skip_trace";

export const IMPORT_SERVICE_DEFAULTS = {
  requestCass: false,
  classifyLineTypes: false,
  requestSkipTrace: false,
} as const;

export type ImportServicePricing = {
  id: ImportPaidServiceId;
  label: string;
  unitPriceUsd: number | null;
  configured: boolean;
  unavailableReason?: string;
};

/**
 * Single pricing registry for the import UI and workflow audit metadata.
 * Values come from the existing provider modules. Skip trace stays disabled
 * until its provider exposes a verified unit price in code.
 */
export const IMPORT_SERVICE_PRICING: Record<
  ImportPaidServiceId,
  ImportServicePricing
> = {
  cass: {
    id: "cass",
    label: "Address verification (CASS)",
    unitPriceUsd: IMPORT_CASS_VERIFIED_COST_USD,
    configured: false,
    unavailableReason:
      "Unavailable during import until Sandra has a verified account-specific CASS rate.",
  },
  line_type: {
    id: "line_type",
    label: "Line-type classification",
    unitPriceUsd: TELNYX_LOOKUP_COST_USD,
    configured: false,
    unavailableReason:
      "Unavailable during import until paid lookups have durable per-number retry checkpoints.",
  },
  skip_trace: {
    id: "skip_trace",
    label: "Skip trace",
    unitPriceUsd: null,
    configured: false,
    unavailableReason:
      "Unavailable during import until Sandra has a verified provider unit price.",
  },
};

export function estimateMaxCostUsd(
  unitPriceUsd: number | null,
  eligible: number,
): number | null {
  if (unitPriceUsd == null) return null;
  return Math.round(unitPriceUsd * eligible * 100) / 100;
}

export function sumEnabledImportServiceEstimates(args: {
  requestCass: boolean;
  classifyLineTypes: boolean;
  requestSkipTrace: boolean;
  cassEligible: number;
  lineTypeEligible: number;
  skipTraceEligible: number;
}): number {
  const estimates = [
    args.requestCass
      ? estimateMaxCostUsd(
          IMPORT_SERVICE_PRICING.cass.unitPriceUsd,
          args.cassEligible,
        )
      : 0,
    args.classifyLineTypes
      ? estimateMaxCostUsd(
          IMPORT_SERVICE_PRICING.line_type.unitPriceUsd,
          args.lineTypeEligible,
        )
      : 0,
    args.requestSkipTrace
      ? estimateMaxCostUsd(
          IMPORT_SERVICE_PRICING.skip_trace.unitPriceUsd,
          args.skipTraceEligible,
        )
      : 0,
  ];
  return estimates.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}
