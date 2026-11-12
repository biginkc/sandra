import type { SupabaseClient } from "@supabase/supabase-js";

import type { DealMachineAddress, DealMachineAttempt, DealMachineShape, DealMachineValueResult } from "@/lib/comps/providers/dealmachine";
import type { Database } from "@/lib/supabase/types";

/**
 * DealMachine value lookup through the `dealmachine_value_cache` claim (PR-E, BUILD-PLAN §15).
 *
 * Only the claim winner calls the provider. Everyone else reads the cached row, or, while a
 * claim is in flight, polls for up to 10 s and then gives up as "no value" (→ fair-price reply
 * + alert). Every failure here also reads as "no value": the price check never sends the
 * repairs reply without a real value.
 *
 * Accounting + rate limit: before EVERY provider HTTP request the store writes a ledger row
 * (`attempt_started`), which is also the shared per-org slot (≤60 per rolling minute across
 * instances). No slot, or a failed write → no request → "no value". After the request the row
 * is settled; a failed settle leaves it `attempt_started`, still counted. Over the limit there
 * is no queue: the reply takes the safe path (fair-price reply + alert).
 *
 * A value is only returned when this caller's claim settles: if the claim was lost (expired
 * and retaken), the result is "no value" (never an obsolete value).
 */
export type ClaimOutcome =
  | { outcome: "claimed"; claimToken: string }
  /** isLand: the stored land signal; null = unknown (pre-signal row, or unreadable). */
  | { outcome: "cached_ok"; value: number; isLand?: boolean | null }
  | { outcome: "cached_negative"; isLand?: boolean | null }
  | { outcome: "in_flight" }
  | { outcome: "backoff" };

export type SettleState = "ok" | "negative" | "failed_retryable";

export interface DealMachineCacheStore {
  claim(propertyId: string, orgId: string): Promise<ClaimOutcome>;
  settle(input: {
    propertyId: string;
    claimToken: string;
    state: SettleState;
    value?: number | null;
    retryAfterSeconds?: number | null;
    error?: string | null;
  }): Promise<boolean>;
  /** Pre-call ledger row + rate-limit slot. Returns the call id, or null when over the limit. Throws on write failure. */
  startAttempt(input: { orgId: string; propertyId: string }): Promise<string | null>;
  settleAttempt(attempt: DealMachineAttempt): Promise<boolean>;
  /** Stores the land signal for the current claim (before settle). Optional; failures = unknown. */
  recordShape?(input: { propertyId: string; claimToken: string; shape: DealMachineShape | null }): Promise<boolean>;
}

/** Shared per-org DealMachine limit (BUILD-PLAN §15: ≤60 calls/min). */
export const DM_CALLS_PER_MINUTE = 60;

export type ValueLookupResult =
  /** isLand: DealMachine record looks like land; null/undefined = unknown (today's behaviour). */
  | { kind: "value"; value: number; source: "provider" | "cache"; isLand?: boolean | null }
  /** isLand may be set when DealMachine matched land but gave no usable value. */
  | { kind: "no_value"; reason: string; isLand?: boolean };

export type LookupDeps = {
  store: DealMachineCacheStore;
  /** The provider call; receives the accounting hooks so every HTTP attempt is ledgered first. */
  callProvider: (
    address: DealMachineAddress,
    hooks: { beforeAttempt: () => Promise<string | null>; onAttempt: (a: DealMachineAttempt) => Promise<void> },
  ) => Promise<DealMachineValueResult>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollIntervalMs?: number;
  /** Losers wait at most this long for the winner (plan: ≤10 s). */
  maxWaitMs?: number;
};

export const DM_LOSER_MAX_WAIT_MS = 10_000;
export const DM_LOSER_POLL_MS = 500;

export function usableAddress(a: Partial<DealMachineAddress> | null | undefined): DealMachineAddress | null {
  const street = a?.street?.trim();
  const city = a?.city?.trim();
  const state = a?.state?.trim();
  if (!street || !city || !state) return null;
  return { street, city, state, zip: a?.zip?.trim() || null };
}

/** Only a known answer is carried; unknown leaves the result exactly as before the land signal. */
const landKey = (isLand: boolean | null | undefined): { isLand?: boolean } => (typeof isLand === "boolean" ? { isLand } : {});

export async function lookupDealMachineValue(
  input: { orgId: string; propertyId: string; address: Partial<DealMachineAddress> | null },
  deps: LookupDeps,
): Promise<ValueLookupResult> {
  const address = usableAddress(input.address);
  if (!address) return { kind: "no_value", reason: "no_address" };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.maxWaitMs ?? DM_LOSER_MAX_WAIT_MS);

  for (;;) {
    let claim: ClaimOutcome;
    try {
      claim = await deps.store.claim(input.propertyId, input.orgId);
    } catch {
      return { kind: "no_value", reason: "claim_error" };
    }
    if (claim.outcome === "cached_ok") return { kind: "value", value: claim.value, source: "cache", ...landKey(claim.isLand) };
    if (claim.outcome === "cached_negative") return { kind: "no_value", reason: "cached_negative", ...landKey(claim.isLand) };
    if (claim.outcome === "backoff") return { kind: "no_value", reason: "backoff" };
    if (claim.outcome === "in_flight") {
      if (now() >= deadline) return { kind: "no_value", reason: "in_flight_timeout" };
      await sleep(deps.pollIntervalMs ?? DM_LOSER_POLL_MS);
      continue;
    }
    return callAndSettle(input, address, claim.claimToken, deps);
  }
}

async function callAndSettle(
  input: { orgId: string; propertyId: string },
  address: DealMachineAddress,
  claimToken: string,
  deps: LookupDeps,
): Promise<ValueLookupResult> {
  const hooks = {
    // Throws on a failed write: the provider then sends nothing (fail closed).
    beforeAttempt: () => deps.store.startAttempt({ orgId: input.orgId, propertyId: input.propertyId }),
    onAttempt: async (attempt: DealMachineAttempt) => {
      try {
        await deps.store.settleAttempt(attempt);
      } catch {
        // Row stays attempt_started: still counted as a spend.
      }
    },
  };
  let res: DealMachineValueResult;
  try {
    res = await deps.callProvider(address, hooks);
  } catch {
    res = { kind: "retryable_error", reason: "provider_threw", retryAfterSeconds: 60 };
  }
  const settle = async (state: SettleState, extra: { value?: number; retryAfterSeconds?: number; error?: string }) => {
    try {
      return await deps.store.settle({ propertyId: input.propertyId, claimToken, state, ...extra });
    } catch {
      return false;
    }
  };

  // Always (re)write the shape for this claim, so a re-lookup never keeps an older land signal.
  if (deps.store.recordShape) {
    try {
      await deps.store.recordShape({
        propertyId: input.propertyId,
        claimToken,
        shape: res.kind === "ok" || res.kind === "no_value" ? res.shape ?? null : null,
      });
    } catch {
      // Not stored: later cache reads say unknown; this call still uses its own answer.
    }
  }
  switch (res.kind) {
    case "ok":
      if (!(await settle("ok", { value: res.value }))) return { kind: "no_value", reason: "settle_lost" };
      return { kind: "value", value: res.value, source: "provider", ...landKey(res.shape?.isLand) };
    case "no_value":
      await settle("negative", { error: res.reason });
      return { kind: "no_value", reason: res.reason, ...landKey(res.shape?.isLand) };
    case "retryable_error":
      await settle("failed_retryable", { retryAfterSeconds: res.retryAfterSeconds, error: res.reason });
      return { kind: "no_value", reason: res.reason };
    case "rate_limited":
    case "accounting_failed":
      // Nothing was sent; free the property again shortly (no queue).
      await settle("failed_retryable", { retryAfterSeconds: 60, error: res.kind });
      return { kind: "no_value", reason: res.kind };
    case "error":
      // Non-retryable (bad request, bad key): do not hammer it; retry no sooner than an hour.
      await settle("failed_retryable", { retryAfterSeconds: 3600, error: res.reason });
      return { kind: "no_value", reason: res.reason };
  }
}

type Rpc = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

/** Service-role store over the 20261030180000 functions. */
export function supabaseDealMachineCacheStore(client: SupabaseClient<Database>): DealMachineCacheStore {
  const db = client as unknown as Rpc;
  return {
    async claim(propertyId, orgId) {
      const { data, error } = await db.rpc("fn_dealmachine_value_claim", { p_property_id: propertyId, p_org_id: orgId });
      if (error) throw new Error("claim failed");
      const row = (Array.isArray(data) ? data[0] : data) as
        | { outcome?: string; claim_token?: string | null; estimated_value?: number | string | null }
        | undefined;
      switch (row?.outcome) {
        case "claimed":
          if (!row.claim_token) throw new Error("claim without token");
          return { outcome: "claimed", claimToken: row.claim_token };
        case "cached_ok": {
          const v = Number(row.estimated_value);
          if (!Number.isFinite(v) || v <= 0) throw new Error("bad cached value");
          return { outcome: "cached_ok", value: v, isLand: await readCachedIsLand(client, propertyId, "ok") };
        }
        case "cached_negative":
          return { outcome: "cached_negative", isLand: await readCachedIsLand(client, propertyId, "negative") };
        case "backoff":
          return { outcome: "backoff" };
        case "in_flight":
          return { outcome: "in_flight" };
        default:
          throw new Error("unknown claim outcome");
      }
    },
    async settle(i) {
      const { data, error } = await db.rpc("fn_dealmachine_value_settle", {
        p_property_id: i.propertyId,
        p_claim_token: i.claimToken,
        p_state: i.state,
        p_estimated_value: i.value ?? null,
        p_retry_after_seconds: i.retryAfterSeconds ?? null,
        p_error: i.error ?? null,
      });
      if (error) throw new Error("settle failed");
      return data === true;
    },
    async startAttempt({ orgId, propertyId }) {
      const { data, error } = await db.rpc("fn_provider_attempt_start", {
        p_provider: "dealmachine",
        p_org_id: orgId,
        p_property_id: propertyId,
        p_limit_per_minute: DM_CALLS_PER_MINUTE,
      });
      if (error) throw new Error("attempt start failed");
      return typeof data === "string" && data ? data : null;
    },
    async recordShape({ propertyId, claimToken, shape }) {
      const { data, error } = await db.rpc("fn_dealmachine_value_record_shape", {
        p_property_id: propertyId,
        p_claim_token: claimToken,
        p_living_area_sqft: shape?.livingAreaSqft ?? null,
        p_num_bedrooms: shape?.numBedrooms ?? null,
        p_is_land: shape?.isLand ?? null,
      });
      // Before 20261111120000 is applied the RPC is missing: unknown, never an error path.
      if (error) return false;
      return data === true;
    },
    async settleAttempt(attempt) {
      const { data, error } = await db.rpc("fn_provider_attempt_settle", {
        p_call_id: attempt.callId,
        p_http_status: attempt.httpStatus,
        p_cost: attempt.creditsUsed,
      });
      if (error) throw new Error("attempt settle failed");
      return data === true;
    },
  };
}

/**
 * The stored land signal for a cached ok/negative row (cleared by the DB on every new claim). Any failure (column not there yet, read error)
 * = null (unknown), which keeps today's price-check behaviour. Never re-bills.
 */
async function readCachedIsLand(client: SupabaseClient<Database>, propertyId: string, state: "ok" | "negative"): Promise<boolean | null> {
  try {
    const { data, error } = await (client as unknown as { from: (t: string) => any }) // eslint-disable-line @typescript-eslint/no-explicit-any
      .from("dealmachine_value_cache").select("is_land").eq("property_id", propertyId).eq("state", state).maybeSingle();
    if (error) return null;
    const v = (data as { is_land?: unknown } | null)?.is_land;
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}
