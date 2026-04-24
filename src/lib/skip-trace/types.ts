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
};

export type SkipTraceResult = {
  /** Round-tripped from input. */
  propertyId: string;
  /** True if the provider returned ≥1 person with at least a phone or email. */
  hit: boolean;
  persons: SkipTracePerson[];
  /** Credits the provider deducted for this lookup. 0 on miss. */
  creditsDeducted: number;
  /** Original provider response, kept for audit / replay. */
  raw: unknown;
};

/** Returned by `submitBatch`. The actual results land later — either via
 *  webhook or `pollBatch(queueId)`. */
export type SkipTraceBatchTicket = {
  queueId: string;
  estimatedWaitSeconds: number;
  creditsPerLead: number;
};

export interface SkipTraceProvider {
  readonly providerId: string;

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
