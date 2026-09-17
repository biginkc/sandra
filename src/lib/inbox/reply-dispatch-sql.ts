import type { ReplyDispatchClaim, ReplyDispatchDependencies, ReplyAttemptResult, ReplyAttemptState } from "./reply-dispatch";
import type { FrozenReply, ReplyProviderResult } from "./reply-provider";

/** Minimal query surface this adapter needs — deliberately not `pg.Pool`/
 * `pg.Client` so it can be exercised against a fake in unit tests without a
 * real database. A single connection (pg.Client checked out for the whole
 * claim() call, per the architect brief's single-connection contract) or a
 * pool are both valid implementations; the worker (runner.mjs) uses the
 * former for claim/authorize/start_dispatch and a pool for persist. */
export interface ReplyDispatchQueryExecutor {
  query<Row extends Record<string, unknown>>(statement: string, params: unknown[]): Promise<{ rows: Row[] }>;
}

const SETTLED = new Set<string>(["skipped_ineligible", "provider_accepted", "uncertain", "confirmed_not_submitted", "rejected_unsent", "delivered", "delivery_failed"]);
function settledResult(attemptId: string, state: string): ReplyAttemptResult {
  if (!SETTLED.has(state)) throw Error(`Unmapped reply attempt state for ${attemptId}: ${state}`);
  return { attemptId, kind: "settled", state: state as ReplyAttemptState };
}

const STALE_CLAIM_CODES = ["INBOX_REPLY_STALE_CLAIM", "INBOX_REPLY_SENDER_BUSY", "INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER", "INBOX_REPLY_FROZEN_MISMATCH"];
function startDispatchFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const code of STALE_CLAIM_CODES) if (message.includes(code)) return code;
  return "start_dispatch_failed";
}

/** SQL adapter implementing ReplyDispatchDependencies against
 * inbox_reply_send.worker_claim/worker_authorize/worker_start_dispatch/
 * worker_persist (experiments/inbox-reply-send-worker/worker.sql) — the
 * SECURITY DEFINER entry points granted to inbox_reply_send_worker.
 * Mirrors experiments/inbox-reply-send-worker/runner.mjs's own JS control
 * flow so both implementations of the single-connection contract (this
 * one and the durable worker's) agree byte-for-byte on the state machine.
 * `claim` folds claim -> worker_authorize (Astra #3) -> start_dispatch
 * (Astra #4) into ONE call, exactly as ReplyDispatchDependencies documents:
 * "One fresh transaction: canonical eligibility, account admission and
 * durable dispatch_started marker." */
export function createReplyDispatchSqlAdapter(
  executor: ReplyDispatchQueryExecutor,
  orgId: string,
  operationId: string,
  transport: (reply: FrozenReply, signal: AbortSignal) => Promise<ReplyProviderResult>,
): ReplyDispatchDependencies {
  return {
    async claim(attemptId): Promise<ReplyDispatchClaim> {
      const claimRow = (await executor.query<{ result: unknown }>("SELECT inbox_reply_send.worker_claim($1,$2) AS result", [orgId, attemptId])).rows[0]?.result;
      if (!claimRow || typeof claimRow !== "object") throw Error("Invalid reply claim result");
      const claim = claimRow as { kind?: string; generation?: string; state?: string };
      if (claim.kind === "busy") return { kind: "deferred", attemptId };
      if (claim.kind === "existing") {
        if (typeof claim.state !== "string") throw Error("Invalid reply claim result");
        return { kind: "existing", result: settledResult(attemptId, claim.state) };
      }
      if (claim.kind !== "claimed" || typeof claim.generation !== "string") throw Error("Invalid reply claim result");
      try {
        await executor.query("SELECT inbox_reply_send.worker_authorize($1,$2)", [orgId, operationId]);
      } catch {
        // [Astra #3] Requester's membership was revoked/expired since
        // acceptance. Do NOT start_dispatch, do NOT send. The attempt stays
        // claimed for lease-expiry (reclaimable by a later pass); nothing is
        // journaled here.
        return { kind: "not_sent", attemptId, reason: "requester_unauthorized" };
      }
      let dispatchRow: unknown;
      try {
        dispatchRow = (await executor.query<{ result: unknown }>("SELECT inbox_reply_send.worker_start_dispatch($1,$2,$3) AS result", [orgId, attemptId, claim.generation])).rows[0]?.result;
      } catch (error) {
        // [Astra #4] never-provider-on-unknown-commit: a thrown/ambiguous
        // start_dispatch means NO token exists. Re-entry goes back through
        // claim() next pass, which reads the row's real committed state —
        // never a provider call from here.
        return { kind: "not_sent", attemptId, reason: startDispatchFailureReason(error) };
      }
      if (!dispatchRow || typeof dispatchRow !== "object") throw Error("Invalid reply start_dispatch result");
      const dispatch = dispatchRow as { kind?: string; reason?: string; token?: string; from?: string; to?: string; body?: string };
      if (dispatch.kind === "skipped") return { kind: "existing", result: settledResult(attemptId, "skipped_ineligible") };
      if (dispatch.kind !== "dispatch" || typeof dispatch.token !== "string" || typeof dispatch.from !== "string" || typeof dispatch.to !== "string" || typeof dispatch.body !== "string") throw Error("Invalid reply start_dispatch result");
      const reply: FrozenReply = { from: dispatch.from, to: dispatch.to, body: dispatch.body };
      return { kind: "dispatch", attemptId, token: dispatch.token, reply };
    },
    // The production seam (createSendilloReplyTransport) is injected by the
    // caller as `transport` — this file has no opinion on which transport is
    // wired and never decides when a real send is permitted; dispatchReplyAttempt
    // only ever calls this after claim() above returned an unambiguous
    // {kind:'dispatch'} result.
    async send(reply, signal): Promise<ReplyProviderResult> { return transport(reply, signal); },
    async persist(attemptId, token, result): Promise<ReplyAttemptResult> {
      const providerResult = result.kind === "accepted" ? { kind: "accepted", externalId: result.externalId, status: result.providerStatus }
        : result.kind === "not_attempted" ? { kind: "not_attempted", reason: result.reason }
        : { kind: "uncertain", reason: result.reason };
      const receiptRow = (await executor.query<{ result: unknown }>("SELECT inbox_reply_send.worker_persist($1,$2,$3,$4::jsonb) AS result", [orgId, attemptId, token, JSON.stringify(providerResult)])).rows[0]?.result;
      if (!receiptRow || typeof receiptRow !== "object") throw Error("Invalid reply persist result");
      const receipt = receiptRow as { state?: string };
      if (typeof receipt.state !== "string") throw Error("Invalid reply persist result");
      return settledResult(attemptId, receipt.state);
    },
  };
}
