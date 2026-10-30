import type { SupabaseClient } from "@supabase/supabase-js";

import type { DealMachineAddress, DealMachineAttempt, DealMachineValueResult } from "@/lib/comps/providers/dealmachine";
import type { Database } from "@/lib/supabase/types";

/**
 * DealMachine value lookup through the `dealmachine_value_cache` claim (PR-E, BUILD-PLAN §15).
 *
 * Only the claim winner calls the provider. Everyone else reads the cached row, or, while a
 * claim is in flight, polls for up to 10 s and then gives up as "no value" (→ fair-price reply
 * + alert). Every failure here also reads as "no value": the price check never sends the
 * repairs reply without a real value.
 */
export type ClaimOutcome =
  | { outcome: "claimed"; claimToken: string }
  | { outcome: "cached_ok"; value: number }
  | { outcome: "cached_negative" }
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
  recordSpend(input: { orgId: string; propertyId: string; attempt: DealMachineAttempt }): Promise<void>;
}

export type ValueLookupResult =
  | { kind: "value"; value: number; source: "provider" | "cache" }
  | { kind: "no_value"; reason: string };

export type LookupDeps = {
  store: DealMachineCacheStore;
  /** The provider call; receives the accounting hook so every HTTP attempt is ledgered. */
  callProvider: (
    address: DealMachineAddress,
    onAttempt: (a: DealMachineAttempt) => Promise<void>,
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
    if (claim.outcome === "cached_ok") return { kind: "value", value: claim.value, source: "cache" };
    if (claim.outcome === "cached_negative") return { kind: "no_value", reason: "cached_negative" };
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
  const onAttempt = async (attempt: DealMachineAttempt) => {
    try {
      await deps.store.recordSpend({ orgId: input.orgId, propertyId: input.propertyId, attempt });
    } catch {
      // Accounting never blocks the lookup.
    }
  };
  let res: DealMachineValueResult;
  try {
    res = await deps.callProvider(address, onAttempt);
  } catch {
    res = { kind: "retryable_error", reason: "provider_threw", retryAfterSeconds: 60 };
  }
  const settle = (state: SettleState, extra: { value?: number; retryAfterSeconds?: number; error?: string }) =>
    deps.store
      .settle({ propertyId: input.propertyId, claimToken, state, ...extra })
      .catch(() => false);

  switch (res.kind) {
    case "ok":
      await settle("ok", { value: res.value });
      return { kind: "value", value: res.value, source: "provider" };
    case "no_value":
      await settle("negative", { error: res.reason });
      return { kind: "no_value", reason: res.reason };
    case "retryable_error":
      await settle("failed_retryable", { retryAfterSeconds: res.retryAfterSeconds, error: res.reason });
      return { kind: "no_value", reason: res.reason };
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
          return { outcome: "cached_ok", value: v };
        }
        case "cached_negative":
          return { outcome: "cached_negative" };
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
    async recordSpend({ orgId, propertyId, attempt }) {
      const { error } = await db.rpc("fn_provider_spend_record", {
        p_call_id: attempt.callId,
        p_provider: "dealmachine",
        p_org_id: orgId,
        p_property_id: propertyId,
        p_http_status: attempt.httpStatus,
        p_cost: attempt.creditsUsed,
      });
      if (error) throw new Error("spend record failed");
    },
  };
}
