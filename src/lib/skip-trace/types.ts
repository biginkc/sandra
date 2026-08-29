/**
 * Provider-agnostic skip-trace types. Tracerfy is the V1 implementation
 * but the interface is shaped so BatchData / idiCORE / Apify can plug in
 * later without touching the runner or UI.
 */

export type SkipTraceInput = {
  /** Our internal property id — round-tripped through async/batch flows
   *  so the runner can match results back to the right row. */
  propertyId: string;
  address: string;
  city: string;
  state: string;
  zip?: string | null;
  /** Optional — providers like Tracerfy can `find_owner` from the address
   *  alone, but you get more accurate matches when you supply the names
   *  you already have (e.g. from a CSV import). */
  firstName?: string | null;
  lastName?: string | null;
  /**
   * Owner's mailing address from `homeowner_details.mailing_*`. Tracerfy's
   * batch endpoint requires a `mail_address_column` for normal traces and
   * uses the value to disambiguate absentee-owner records. When absent,
   * the adapter falls back to the property address — correct for owner-
   * occupied properties, an acceptable approximation for absentees.
   */
  mailingAddress?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingZip?: string | null;
};

export type SkipTracePhone = {
  /** E.164 if the provider returned it that way; raw otherwise. */
  number: string;
  type: "Mobile" | "Landline" | "Unknown";
  /** True if the number is on a Do-Not-Call registry. */
  dnc: boolean;
  /** Provider-assigned 1..N rank; 1 = best match. */
  rank: number;
  carrier?: string | null;
};

export type SkipTraceEmail = {
  email: string;
  rank: number;
};

export type SkipTracePerson = {
  firstName?: string | null;
  lastName?: string | null;
  phones: SkipTracePhone[];
  emails: SkipTraceEmail[];
  /** True when the provider flags this person as the property owner. */
  isOwner?: boolean;
  /** Person-level mailing address. Tracerfy's instant lookup returns this
   *  per person nested under a `mailing_address` object; batch results
   *  surface a single row-level mailing address (see SkipTraceResult). */
  mailingAddress?: SkipTraceMailingAddress | null;
};

/**
 * Normalized mailing address shape returned by skip-trace providers. Used
 * to upgrade `homeowner_details.mailing_*` when the provider discovers an
 * owner's current mailing address that the original CSV import didn't have.
 */
export type SkipTraceMailingAddress = {
  street?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
};

export type SkipTraceResult = {
  /** Round-tripped from input — for sync lookups and cache hits this is
   *  authoritative. For async batches (Tracerfy especially), the
   *  provider does NOT reliably round-trip `external_id`, so callers
   *  must match by `matchedAddress` instead. May be `""` for batch
   *  rows where no external_id came back. */
  propertyId: string;
  /** Echo of the property address the provider matched against. The
   *  finalize step uses this to fan a single result out to every
   *  property in our system that shared the same input address —
   *  necessary because Tracerfy silently dedupes batches by address
   *  and doesn't return `external_id` per row. Sync lookups omit this
   *  (propertyId is reliable in that path). */
  matchedAddress?: { address: string; city: string; state: string } | null;
  /** True if the provider returned ≥1 person with at least a phone or email. */
  hit: boolean;
  persons: SkipTracePerson[];
  /** Credits the provider deducted for this lookup. 0 on miss. */
  creditsDeducted: number;
  /** Row-level mailing address from a batch response. Tracerfy's batch
   *  result returns mailing fields at the row level (`mail_address`,
   *  `mail_city`, `mail_state`) rather than nested under each person.
   *  Single lookups populate this from the first owner person's
   *  `mailingAddress` so callers have one consistent place to read from. */
  mailingAddress?: SkipTraceMailingAddress | null;
  /** Original provider response, kept for audit / replay. */
  raw: unknown;
};

/** Returned by `submitBatch`. The actual results land later — either via
 *  webhook or `pollBatch(queueId)`. */
export type SkipTraceBatchTicket = {
  queueId: string;
  estimatedWaitSeconds: number;
  creditsPerLead: number;
  traceType?: "normal" | "advanced" | "enhanced";
};

export interface SkipTraceProvider {
  readonly providerId: string;

  /**
   * Rebuild a cached normalized result from its preserved provider payload.
   * Providers may use this to repair projections after a parser change
   * without paying for the same lookup again. Return null when the payload
   * cannot be interpreted safely and the caller should treat it as a miss.
   */
  normalizeCachedResult?(result: SkipTraceResult): SkipTraceResult | null;

  /**
   * Synchronous single-address lookup. Returns the result inline.
   * Returns a result with `hit: false` (NOT null) on a clean miss so
   * callers can persist a "we tried; no match" cache row.
   * Throws `ProviderError` on transport / non-2xx responses.
   * Throws `ConfigurationError` if creds are missing.
   */
  lookupSingle(input: SkipTraceInput): Promise<SkipTraceResult>;

  /**
   * Submit a batch of addresses for async processing. Caller persists
   * the returned `queueId` and waits for results via webhook or by
   * polling `pollBatch(queueId)`.
   */
  submitBatch(inputs: SkipTraceInput[]): Promise<SkipTraceBatchTicket>;

  /**
   * Fetch a previously-submitted batch by id. Returns `null` while the
   * batch is still pending so callers can keep polling. Returns the
   * full result list when complete.
   */
  pollBatch(queueId: string): Promise<SkipTraceResult[] | null>;

  /** Current account credit balance — used for spend-cap pre-flight. */
  getBalance(): Promise<number>;
}
