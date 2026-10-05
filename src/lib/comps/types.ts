/** Comps domain types (TECH-PLAN-2026-10 §3.2). Pure types, safe for client bundles. */
export type CompProviderName = "attom" | "fixture";
export type CompTrigger = "top_ten" | "manual" | "repair";

export type CompSubject = {
  propertyId: string;
  orgId: string;
  address: string;
  city: string | null;
  state: string;
  zip: string | null;
  attomId: string | null;
  fips: string | null;
  apn: string | null;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  yearBuilt: number | null;
  lat: number | null;
  lon: number | null;
};

export type CompSale = {
  address: string;
  saleDate: string;
  salePrice: number;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  yearBuilt: number | null;
  distanceMiles: number | null;
  providerId: string | null;
  renovatedHint: boolean | null;
};

export type ProviderCompResult = {
  providerPropertyId: string | null;
  asIs: {
    value: number | null;
    low: number | null;
    high: number | null;
    score: number | null;
    /** Forecast standard deviation as a percent of value (ATTOM `avm.amount.fsd`). */
    fsdPct: number | null;
  };
  comps: CompSale[];
  ownerOfRecord: string | null;
  legal: { text: string | null; complete: boolean };
  billedCalls: number;
  raw: Record<string, unknown>;
};

export type CompProviderErrorCode =
  | "AUTH"
  | "RATE_LIMIT"
  | "NOT_FOUND"
  | "TIMEOUT"
  | "UPSTREAM"
  | "INVALID_RESPONSE";

export class CompProviderError extends Error {
  constructor(
    readonly code: CompProviderErrorCode,
    readonly billedCalls: number,
    readonly retryAfterSec?: number,
  ) {
    super(code);
    this.name = "CompProviderError";
  }
}

export interface CompProvider {
  readonly name: CompProviderName;
  /** HTTP requests one comp normally costs; the cap ledger reserves `org_comp_settings.calls_per_comp`. */
  readonly callsPerComp: number;
  fetch(subject: CompSubject, signal: AbortSignal): Promise<ProviderCompResult>;
}

export type CompLeadResult =
  | { status: "ready"; compId: string; cached: boolean }
  | { status: "pending"; requestId: string }
  | { status: "capped" }
  | { status: "disabled" }
  | { status: "no_match" }
  | { status: "unavailable"; reason: "training_lead" | "missing_address" | "not_found" }
  | { status: "error"; code: string };

/** Thresholds read from `org_comp_settings` (defaults mirror the migration). */
export type CompSettings = {
  verify_min_comps: number;
  verify_max_fsd_pct: number;
};

export const DEFAULT_COMP_SETTINGS: CompSettings = { verify_min_comps: 3, verify_max_fsd_pct: 15 };

export type VerifyReason = "no_avm" | "wide_range" | "few_comps" | "legal_incomplete";

/** The `lead_comps` row shape the server writes (never `arv_estimate`: ARV is Jarrad's own number). */
export type LeadCompRow = {
  id: string;
  org_id: string;
  property_id: string;
  provider: CompProviderName;
  request_id: string | null;
  fetched_at: string;
  as_is_value: number | null;
  as_is_low: number | null;
  as_is_high: number | null;
  confidence: "high" | "medium" | "low" | null;
  confidence_score: number | null;
  verify_first: boolean;
  verify_reasons: VerifyReason[];
  arv_estimate: null;
  arv_method: "none";
  comps: CompSale[];
  owner_of_record: string | null;
  legal_description: string | null;
  legal_description_complete: boolean;
  provider_property_id: string | null;
  raw: Record<string, unknown>;
};

/** Columns a member may read (`raw` is service-only by column grant). */
export const LEAD_COMPS_MEMBER_COLUMNS =
  "id, org_id, property_id, provider, request_id, fetched_at, as_is_value, as_is_low, as_is_high, confidence, confidence_score, verify_first, verify_reasons, arv_estimate, arv_method, comps, owner_of_record, legal_description, legal_description_complete, provider_property_id";
