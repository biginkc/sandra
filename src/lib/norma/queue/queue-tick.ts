import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { STATE_TO_TZ } from "@/lib/messaging/quiet-hours";
import type { Database } from "@/lib/supabase/types";

import type { DispatchResult } from "../dispatch";
import { applyNormaQueuePresend, fail, looseRpc } from "../rpc";
import type { NormaQueueConfig } from "./config";
import type { PreSendResult } from "./pre-send-transition";

/**
 * The queue tick (plan "Cron" 1-4). SQL owns every entry transition and every reschedule: the tick only asks the
 * contract functions (docs/norma/queue-sql-contract.md s.4) to act and reacts to what they answer. No per-tick
 * ceiling and no sleeps; the loop ends when nothing is due, capacity refuses, or the time budget is spent.
 */

/** The cron route sizes maxDuration (60 s) against this. */
export const QUEUE_TICK_BUDGET_MS = 50_000;

export type QueueClaimResult = {
  /** claimed | blocked:<reason> | window_closed | disabled | not_due | not_claimable | capacity_precheck | already_open | unknown_state */
  result: string;
  entryId?: string;
  propertyId?: string;
  contactId?: string;
  phoneE164?: string;
  requestedBy?: string;
  repContext?: string | null;
  leaseToken?: string;
  dispatchToken?: string;
};

export type QueueLimits = { enabled: boolean; maxConcurrent: number; dailyCap: number; capTz: string };

export type QueueCreateInput = {
  entryId: string;
  leaseToken: string;
  propertyId: string;
  contactId: string;
  phoneE164: string;
  requestedBy: string;
  repContext: string | null;
};

export type QueueCreateResult = {
  outcome: "created" | "already_open" | "blocked";
  requestId: string | null;
  blockReason?: string | null;
};

export type QueueLiveEntry = { id: string; propertyId: string; status: string; propertyState: string | null };

/** Thin wrappers over the SQL contract, one per function, plus two read ports. */
export type QueueTickStore = {
  releaseExpiredLeases(nowIso: string): Promise<number>;
  sweepReplies(): Promise<number>;
  sweepBlocks(): Promise<number>;
  listLiveEntries(): Promise<QueueLiveEntry[]>;
  pauseUnknownState(entryId: string): Promise<string>;
  listDueEntryIds(nowIso: string): Promise<string[]>;
  claim(entryId: string, nowIso: string, limits: QueueLimits): Promise<QueueClaimResult>;
  createRequest(input: QueueCreateInput): Promise<QueueCreateResult>;
  applyPresend(requestId: string, token: string): Promise<string>;
};

/** What the dispatcher reported for a queue request, in the shapes rule 4 distinguishes. */
export type QueueDispatchResult = PreSendResult | { kind: "dispatched" } | { kind: "not_claimed" };

export type QueueTickDeps = {
  config: NormaQueueConfig;
  now: () => number;
  store: QueueTickStore;
  dispatch: (requestId: string, ctx: { entryId: string; dispatchToken: string }) => Promise<QueueDispatchResult>;
};

export type QueueTickSummary = {
  claimed: number;
  dispatched: number;
  errors: number;
  stoppedBy: "no_due" | "budget" | "capacity" | "disabled";
};

/** The exact contract token handed to `fn_norma_queue_apply_presend`, or null when nothing is applied. */
export function preSendToken(result: QueueDispatchResult): string | null {
  switch (result.kind) {
    case "dispatched":
    case "not_claimed":
      return null;
    case "queue_refused":
      return `queue_refused:${result.reason}`;
    case "gate":
      return `gate:${result.reason}`;
    case "ineligible":
      return `ineligible:${result.reason}`;
    case "bland_http":
      return result.httpStatus >= 400 && result.httpStatus < 500 && result.httpStatus !== 408
        ? `bland_rejected:${result.httpStatus}`
        : "bland_unknown";
    case "bland_timeout":
      return "bland_unknown";
    case "capacity_concurrency":
    case "capacity_daily":
    case "number_busy":
    case "bland_not_configured":
    case "pre_send_error":
    case "stranded_requested_expired":
      return result.kind;
  }
}

const KNOWN_QUEUE_REFUSALS = new Set(["window_closed", "lease_expired", "lease_mismatch", "token_rotated", "queue_disabled", "control_off", "blocked"]);

/**
 * Production adapter: `dispatchNormaCall`'s result -> the shapes above. Anything it cannot place safely is
 * `pre_send_error`, which requeues the entry for the next tick without counting an attempt.
 */
export function queueResultFromDispatch(result: DispatchResult): QueueDispatchResult {
  switch (result.status) {
    case "dispatched":
      return { kind: "dispatched" };
    case "not_claimed":
    case "not_found":
      return { kind: "not_claimed" };
    case "busy":
      return { kind: result.reason };
    case "unknown":
      // The send may have reached Bland (bind failed, timeout, 408 / 5xx): never redialled, resolved later.
      return { kind: "bland_timeout" };
    case "rejected": {
      const reason = result.reason;
      if (reason.startsWith("queue_refused:")) return { kind: "queue_refused", reason: reason.slice("queue_refused:".length) };
      if (reason.startsWith("ineligible:")) return { kind: "ineligible", reason: reason.slice("ineligible:".length) };
      if (reason === "dispatch_disabled" || reason === "number_not_allowed") return { kind: "gate", reason };
      if (reason === "bland_not_configured") return { kind: "bland_not_configured" };
      if (reason === "pre_send_error") return { kind: "pre_send_error" };
      const http = /^bland_(\d{3})$/.exec(reason);
      if (http) return { kind: "bland_http", httpStatus: Number(http[1]) };
      // mark_sending refusals on queue rows come back unprefixed (SQL already closed the request).
      if (KNOWN_QUEUE_REFUSALS.has(reason)) return { kind: "queue_refused", reason };
      return { kind: "pre_send_error" };
    }
  }
}

function stateIsKnown(state: string | null): boolean {
  return typeof state === "string" && state !== "" && Object.prototype.hasOwnProperty.call(STATE_TO_TZ, state);
}

export async function runNormaQueueTick(deps: QueueTickDeps): Promise<QueueTickSummary | { skipped: "disabled" }> {
  const { config, store } = deps;
  if (!config.enabled || config.maxConcurrent === null || config.dailyCap === null) return { skipped: "disabled" };
  const limits: QueueLimits = { enabled: true, maxConcurrent: config.maxConcurrent, dailyCap: config.dailyCap, capTz: config.capTz };

  const startedAt = deps.now();
  const summary: QueueTickSummary = { claimed: 0, dispatched: 0, errors: 0, stoppedBy: "no_due" };
  const guarded = async (surface: string, extra: Record<string, unknown>, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch (error) {
      summary.errors += 1;
      reportError(error, { tags: { surface: `norma_queue_tick_${surface}` }, extra });
    }
  };

  // ---- maintenance: lease watchdog -> reply sweep -> block sweep -> unknown-state pause ----
  await guarded("release_leases", {}, () => store.releaseExpiredLeases(new Date(deps.now()).toISOString()));
  await guarded("sweep_replies", {}, () => store.sweepReplies());
  await guarded("sweep_blocks", {}, () => store.sweepBlocks());
  let live: QueueLiveEntry[] = [];
  await guarded("list_live", {}, async () => {
    live = await store.listLiveEntries();
  });
  for (const entry of live) {
    if (entry.status !== "queued" && entry.status !== "calling") continue;
    if (stateIsKnown(entry.propertyState)) continue;
    await guarded("pause_unknown_state", { entryId: entry.id }, () => store.pauseUnknownState(entry.id));
  }

  // ---- claim -> create -> dispatch loop ----
  const attempted = new Set<string>();
  for (;;) {
    if (deps.now() - startedAt >= QUEUE_TICK_BUDGET_MS) {
      summary.stoppedBy = "budget";
      break;
    }
    let dueIds: string[] = [];
    try {
      dueIds = await store.listDueEntryIds(new Date(deps.now()).toISOString());
    } catch (error) {
      summary.errors += 1;
      reportError(error, { tags: { surface: "norma_queue_tick_list_due" } });
      summary.stoppedBy = "no_due";
      break;
    }
    const entryId = dueIds.find((id) => !attempted.has(id));
    if (!entryId) {
      summary.stoppedBy = "no_due";
      break;
    }
    attempted.add(entryId);

    let claim: QueueClaimResult;
    try {
      claim = await store.claim(entryId, new Date(deps.now()).toISOString(), limits);
    } catch (error) {
      summary.errors += 1;
      reportError(error, { tags: { surface: "norma_queue_tick_claim" }, extra: { entryId } });
      continue;
    }
    if (claim.result === "capacity_precheck") {
      summary.stoppedBy = "capacity";
      break;
    }
    if (claim.result === "disabled") {
      summary.stoppedBy = "disabled";
      break;
    }
    if (claim.result !== "claimed") continue; // blocked / window_closed / not_due / not_claimable / already_open / unknown_state: SQL owns it
    summary.claimed += 1;
    if (!claim.leaseToken || !claim.dispatchToken || !claim.propertyId || !claim.contactId || !claim.phoneE164 || !claim.requestedBy) {
      summary.errors += 1;
      reportError(new Error("norma queue claim returned an incomplete row"), { tags: { surface: "norma_queue_tick_claim" }, extra: { entryId } });
      continue;
    }

    let created: QueueCreateResult;
    try {
      created = await store.createRequest({
        entryId,
        leaseToken: claim.leaseToken,
        propertyId: claim.propertyId,
        contactId: claim.contactId,
        phoneE164: claim.phoneE164,
        requestedBy: claim.requestedBy,
        repContext: claim.repContext ?? null,
      });
    } catch (error) {
      // The lease watchdog recovers the entry.
      summary.errors += 1;
      reportError(error, { tags: { surface: "norma_queue_tick_create" }, extra: { entryId } });
      continue;
    }
    if (created.outcome === "already_open") continue;
    if (created.outcome === "blocked") {
      // Nothing was created when there is no request id (button parity); the block triggers / sweeps recover the entry.
      if (created.requestId) {
        const requestId = created.requestId;
        await guarded("apply_presend", { requestId }, () => store.applyPresend(requestId, `ineligible:${created.blockReason ?? "eligibility_check_failed"}`));
      }
      continue;
    }
    if (!created.requestId) {
      summary.errors += 1;
      continue;
    }
    const requestId = created.requestId;

    let result: QueueDispatchResult;
    try {
      result = await deps.dispatch(requestId, { entryId, dispatchToken: claim.dispatchToken });
    } catch (error) {
      // The request stays open for reconcile.
      summary.errors += 1;
      reportError(error, { tags: { surface: "norma_queue_tick_dispatch" }, extra: { entryId, requestId } });
      continue;
    }
    if (result.kind === "dispatched") summary.dispatched += 1;
    const token = preSendToken(result);
    if (token !== null) await guarded("apply_presend", { requestId, token }, () => store.applyPresend(requestId, token));
    if (result.kind === "capacity_concurrency" || result.kind === "capacity_daily") {
      summary.stoppedBy = "capacity";
      break;
    }
  }
  return summary;
}

// ---- production store: thin wrappers over the SQL contract ----------------------------------------------------

type Client = SupabaseClient<Database>;
type LooseTable = {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => LooseQuery;
      eq: (column: string, value: string) => LooseQuery;
    };
  };
};
type LooseQuery = PromiseLike<{ data: unknown; error: { message: string } | null }> & {
  lte: (column: string, value: string) => LooseQuery;
  is: (column: string, value: null) => LooseQuery;
  order: (column: string, opts?: { ascending?: boolean }) => LooseQuery;
  limit: (n: number) => LooseQuery;
};

const DUE_PAGE = 25;

function firstRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) return (data[0] as Record<string, unknown> | undefined) ?? null;
  return data && typeof data === "object" ? (data as Record<string, unknown>) : null;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function createQueueTickStore(client: Client): QueueTickStore {
  const rpc = looseRpc(client);
  const table = client as unknown as LooseTable;
  const count = async (name: string, args?: Record<string, unknown>): Promise<number> => {
    const { data, error } = await rpc.rpc(name, args);
    if (error) fail(name, error);
    return typeof data === "number" ? data : 0;
  };
  return {
    releaseExpiredLeases: (nowIso) => count("fn_norma_queue_release_expired_leases", { p_now: nowIso }),
    sweepReplies: () => count("fn_norma_queue_sweep_replies"),
    sweepBlocks: () => count("fn_norma_queue_sweep_blocks"),
    async pauseUnknownState(entryId) {
      const { data, error } = await rpc.rpc("fn_norma_queue_pause_unknown_state", { p_entry_id: entryId });
      if (error) fail("fn_norma_queue_pause_unknown_state", error);
      return String(data);
    },
    async listLiveEntries() {
      const { data, error } = await table.from("norma_queue_entries").select("id, property_id, status, properties(state)").in("status", ["queued", "calling"]);
      if (error) throw new Error(`norma queue live entries failed: ${error.message}`);
      return ((data ?? []) as Array<{ id: string; property_id: string; status: string; properties: { state: string | null } | { state: string | null }[] | null }>).map((row) => {
        const property = Array.isArray(row.properties) ? row.properties[0] : row.properties;
        return { id: row.id, propertyId: row.property_id, status: row.status, propertyState: property?.state ?? null };
      });
    },
    async listDueEntryIds(nowIso) {
      const { data, error } = await table
        .from("norma_queue_entries")
        .select("id")
        .eq("status", "queued")
        .lte("next_attempt_at", nowIso)
        .is("blocked_reason", null)
        .order("next_attempt_at", { ascending: true })
        .limit(DUE_PAGE);
      if (error) throw new Error(`norma queue due list failed: ${error.message}`);
      return ((data ?? []) as Array<{ id: string }>).map((row) => row.id);
    },
    async claim(entryId, nowIso, limits) {
      const { data, error } = await rpc.rpc("fn_norma_queue_claim", {
        p_entry_id: entryId,
        p_now: nowIso,
        p_queue_enabled: limits.enabled,
        p_max_concurrent: limits.maxConcurrent,
        p_daily_cap: limits.dailyCap,
        p_cap_tz: limits.capTz,
      });
      if (error) fail("fn_norma_queue_claim", error);
      const row = firstRow(data);
      if (!row || typeof row.result !== "string") throw new Error("fn_norma_queue_claim: unexpected result");
      return {
        result: row.result,
        entryId: str(row.entry_id),
        propertyId: str(row.property_id),
        contactId: str(row.contact_id),
        phoneE164: str(row.phone_e164),
        requestedBy: str(row.requested_by),
        repContext: typeof row.rep_context === "string" ? row.rep_context : null,
        leaseToken: str(row.lease_token),
        dispatchToken: str(row.dispatch_token),
      };
    },
    async createRequest(input) {
      const { data, error } = await rpc.rpc("fn_norma_create_request_v2", {
        p_property_id: input.propertyId,
        p_contact_id: input.contactId,
        p_phone_e164: input.phoneE164,
        p_requested_by: input.requestedBy,
        p_rep_context: input.repContext,
        // The queue's callback owner is the requester.
        p_callback_assignee_id: input.requestedBy,
        p_queue_entry_id: input.entryId,
        p_queue_lease_token: input.leaseToken,
      });
      if (error) fail("fn_norma_create_request_v2", error);
      const row = firstRow(data);
      if (!row) throw new Error("fn_norma_create_request_v2: empty result");
      if (row.outcome === "created" && typeof row.request_id === "string") return { outcome: "created", requestId: row.request_id };
      if (row.outcome === "already_open") return { outcome: "already_open", requestId: str(row.request_id) ?? null };
      return { outcome: "blocked", requestId: str(row.request_id) ?? null, blockReason: str(row.block_reason) ?? null };
    },
    applyPresend: (requestId, token) => applyNormaQueuePresend(client, requestId, token),
  };
}
