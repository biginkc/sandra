import type { FrozenReply, ReplyProviderResult } from "./reply-provider";

// [Astra #4] Vocabulary realigned to the ledger's own state machine
// (experiments/inbox-reply-send/attempts.sql:104), never a reinvented one.
// "settled" states are exhaustive: they are the ONLY seven values
// claim()/persist() ever hand back for an attempt row once it is out of
// {approved,claimed,dispatch_started} (attempts.sql:340-349 "existing" branch,
// :455-502 persist's own terminal branches). `provider_accepted` is
// deliberately NOT called "accepted" and is NEVER treated as final here — a
// provider `{kind:'accepted'}` result becomes ledger `provider_accepted`,
// which stays PROVISIONAL until PR-G's delivery callback
// (`delivered`/`delivery_failed`). `rejected_unsent` is reserved: no function
// in attempts.sql/accept.sql/worker.sql currently produces it (see D-6(1)'s
// header note); it is listed in the type/switch only so a future producer
// does not silently fall through this exhaustive translation unnoticed, and
// PR-F invents no transition that reaches it.
export type ReplyAttemptState =
  | "skipped_ineligible"
  | "provider_accepted"
  | "uncertain"
  | "confirmed_not_submitted"
  | "rejected_unsent"
  | "delivered"
  | "delivery_failed";

// Three disjoint outcome shapes, never conflated:
//  - "settled": the ledger recorded one of the seven states above.
//  - "deferred": SENDER_BUSY / lease held elsewhere (Astra #4) — nothing was
//    journaled, nothing was sent; retry on a later pass.
//  - "not_sent": the requester's re-auth failed (Astra #3), or start_dispatch
//    itself raised/returned ambiguously (never-provider-on-unknown-commit,
//    Astra #4) — again nothing was journaled and nothing was sent.
export type ReplyAttemptResult =
  | { attemptId: string; kind: "settled"; state: ReplyAttemptState }
  | { attemptId: string; kind: "deferred" }
  | { attemptId: string; kind: "not_sent"; reason: string };

export type ReplyDispatchClaim =
  | { kind: "existing"; result: ReplyAttemptResult }
  | { kind: "deferred"; attemptId: string }
  | { kind: "not_sent"; attemptId: string; reason: string }
  | { kind: "dispatch"; attemptId: string; token: string; reply: FrozenReply };

export interface ReplyDispatchDependencies {
  /** One fresh transaction (or fenced sequence on one connection): canonical
   * eligibility, requester re-authorization (Astra #3) and the durable
   * dispatch_started marker. Existing markers NEVER return another dispatch
   * token; a busy sender NEVER returns a dispatch token either — it returns
   * `deferred`. Do not journal this method separately from the enclosing
   * dispatch function. */
  claim: (attemptId: string) => Promise<ReplyDispatchClaim>;
  send: (reply: FrozenReply, signal: AbortSignal) => Promise<ReplyProviderResult>;
  /** Idempotent same-attempt/token receipt persistence; must reconcile an already
   * stored acceptance rather than overwrite it with an uncertain state. Always
   * returns a "settled" result — persist() is only ever called after a real
   * dispatch token, never for a deferred/not_sent claim. */
  persist: (attemptId: string, token: string, result: ReplyProviderResult) => Promise<ReplyAttemptResult>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Exhaustive, no-ELSE translation (mirrors operation_status's own CASE with
 * no ELSE, accept.sql/public-api.sql). Throws on any value the ledger's own
 * CHECK constraint would not allow through claim()/persist() in the first
 * place — never a silent default. */
function assertSettledState(state: string, attemptId: string): ReplyAttemptState {
  switch (state) {
    case "skipped_ineligible":
    case "provider_accepted":
    case "uncertain":
    case "confirmed_not_submitted":
    case "rejected_unsent":
    case "delivered":
    case "delivery_failed":
      return state;
    default:
      throw Error(`Unmapped reply attempt state for ${attemptId}: ${state}`);
  }
}

/** Run as ONE durable step. On restart re-enter through claim; never replay a
 * previously journaled permission and then repeat the external provider call.
 * NEVER calls send() unless claim() returned an unambiguous {kind:'dispatch'}
 * — a deferred (busy) or not_sent (unauthorized / ambiguous-commit) claim
 * returns immediately, no provider call, ever. */
export async function dispatchReplyAttempt(attemptId: string, dependencies: ReplyDispatchDependencies, signal: AbortSignal): Promise<ReplyAttemptResult> {
  if (!UUID.test(attemptId)) throw Error("Invalid reply attempt");
  const claim = await dependencies.claim(attemptId);
  if (claim.kind === "existing") {
    if (claim.result.attemptId !== attemptId) throw Error("Reply receipt identity mismatch");
    if (claim.result.kind === "settled") assertSettledState(claim.result.state, attemptId);
    return claim.result;
  }
  if (claim.kind === "deferred") {
    if (claim.attemptId !== attemptId) throw Error("Reply claim identity mismatch");
    return { attemptId, kind: "deferred" };
  }
  if (claim.kind === "not_sent") {
    if (claim.attemptId !== attemptId) throw Error("Reply claim identity mismatch");
    return { attemptId, kind: "not_sent", reason: claim.reason };
  }
  if (claim.kind !== "dispatch") throw Error("Unmapped reply claim result");
  if (claim.attemptId !== attemptId || !UUID.test(claim.token)) throw Error("Reply claim identity mismatch");
  let result: ReplyProviderResult;
  // Once claim resolves to a dispatch token, that marker is durable. A thrown
  // sender can never mean permission to retry: transport provenance may have
  // been lost in the throw.
  try { result = await dependencies.send(claim.reply, signal); }
  catch { result = { kind: "uncertain", reason: "transport_or_timeout" }; }
  // Persist only this frozen result. A persistence failure escapes to the durable
  // runner; re-entry cannot obtain a second provider dispatch token. The SQL
  // adapter can retry/reconcile persistence without invoking send again.
  const receipt = await dependencies.persist(attemptId, claim.token, result);
  if (receipt.attemptId !== attemptId) throw Error("Reply receipt identity mismatch");
  if (receipt.kind !== "settled") throw Error("Reply persist must return a settled state");
  assertSettledState(receipt.state, attemptId);
  if (result.kind === "accepted" && receipt.state !== "provider_accepted") throw Error("Provider acceptance was not durably retained");
  return receipt;
}
