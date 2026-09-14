import type { FrozenReply, ReplyProviderResult } from "./reply-provider";

export type ReplyAttemptState = "accepted" | "not_attempted" | "uncertain" | "blocked";
export type ReplyAttemptResult = { attemptId: string; state: ReplyAttemptState };
export type ReplyDispatchClaim =
  | { kind: "existing"; result: ReplyAttemptResult }
  | { kind: "dispatch"; attemptId: string; token: string; reply: FrozenReply };
export interface ReplyDispatchDependencies {
  /** One fresh transaction: canonical eligibility, account admission and durable
   * dispatch_started marker. Existing markers NEVER return another dispatch token.
   * Do not journal this method separately from the enclosing dispatch function. */
  claim: (attemptId: string) => Promise<ReplyDispatchClaim>;
  send: (reply: FrozenReply, signal: AbortSignal) => Promise<ReplyProviderResult>;
  /** Idempotent same-attempt/token receipt persistence; must reconcile an already
   * stored acceptance rather than overwrite it with an uncertain state. */
  persist: (attemptId: string, token: string, result: ReplyProviderResult) => Promise<ReplyAttemptResult>;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Run as ONE durable step. On restart re-enter through claim; never replay a
 * previously journaled permission and then repeat the external provider call. */
export async function dispatchReplyAttempt(attemptId: string, dependencies: ReplyDispatchDependencies, signal: AbortSignal): Promise<ReplyAttemptResult> {
  if (!UUID.test(attemptId)) throw Error("Invalid reply attempt");
  const claim = await dependencies.claim(attemptId);
  if (claim.kind === "existing") {
    if (claim.result.attemptId !== attemptId) throw Error("Reply receipt identity mismatch");
    return claim.result;
  }
  if (claim.attemptId !== attemptId || !UUID.test(claim.token)) throw Error("Reply claim identity mismatch");
  let result: ReplyProviderResult;
  // Once claim resolves, its marker is durable. A thrown sender can never mean
  // permission to retry: transport provenance may have been lost in the throw.
  try { result = await dependencies.send(claim.reply, signal); }
  catch { result = { kind: "uncertain", reason: "transport_or_timeout" }; }
  // Persist only this frozen result. A persistence failure escapes to the durable
  // runner; re-entry cannot obtain a second provider dispatch token. The SQL
  // adapter can retry/reconcile persistence without invoking send again.
  const receipt = await dependencies.persist(attemptId, claim.token, result);
  if (receipt.attemptId !== attemptId) throw Error("Reply receipt identity mismatch");
  if (result.kind === "accepted" && receipt.state !== "accepted") throw Error("Provider acceptance was not durably retained");
  return receipt;
}
