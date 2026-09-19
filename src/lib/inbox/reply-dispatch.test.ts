import { expect, it, vi } from "vitest";
import { dispatchReplyAttempt, type ReplyDispatchDependencies, type ReplyAttemptResult } from "./reply-dispatch";
const attemptId = "11111111-1111-1111-1111-111111111111", token = "22222222-2222-2222-2222-222222222222";
const reply = { from: "+18165550001", to: "+18165550002", body: "Approved text" };
function fixture() {
  let marker = false, stored: ReplyAttemptResult | undefined;
  const deps: ReplyDispatchDependencies = {
    claim: vi.fn<ReplyDispatchDependencies["claim"]>(async () => {
      if (marker) return { kind: "existing", result: stored ?? { attemptId, kind: "settled", state: "uncertain" } };
      marker = true; return { kind: "dispatch", attemptId, token, reply };
    }),
    send: vi.fn<ReplyDispatchDependencies["send"]>(async () => ({ kind: "accepted", provider: "sendillo", externalId: "owned-reference", providerStatus: "accepted" })),
    persist: vi.fn(async (_id, _token, result) => {
      stored = { attemptId, kind: "settled", state: result.kind === "accepted" ? "provider_accepted" : result.kind === "not_attempted" ? "confirmed_not_submitted" : "uncertain" };
      return stored;
    }),
  };
  return deps;
}
const signal = () => new AbortController().signal;
it("duplicate delivery reconciles the receipt with only one provider call", async () => {
  const deps = fixture();
  expect(await dispatchReplyAttempt(attemptId, deps, signal())).toEqual({ attemptId, kind: "settled", state: "provider_accepted" });
  expect(await dispatchReplyAttempt(attemptId, deps, signal())).toEqual({ attemptId, kind: "settled", state: "provider_accepted" });
  expect(deps.send).toHaveBeenCalledOnce();
});
it("lost acceptance persistence cannot trigger a second send on durable replay", async () => {
  const deps = fixture(); deps.persist = vi.fn(async () => { throw Error("lost receipt connection"); });
  await expect(dispatchReplyAttempt(attemptId, deps, signal())).rejects.toThrow("lost receipt connection");
  expect(await dispatchReplyAttempt(attemptId, deps, signal())).toEqual({ attemptId, kind: "settled", state: "uncertain" });
  expect(deps.send).toHaveBeenCalledOnce();
});
it("a thrown transport is persisted as uncertain and not retried", async () => {
  const deps = fixture(); deps.send = vi.fn(async () => { throw Error("transport lost"); });
  const first = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(first.kind).toBe("settled"); if (first.kind === "settled") expect(first.state).toBe("uncertain");
  const second = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(second.kind).toBe("settled"); if (second.kind === "settled") expect(second.state).toBe("uncertain");
  expect(deps.send).toHaveBeenCalledOnce();
});
it("a lost claim response never reaches the provider", async () => {
  const deps = fixture(), original = deps.claim;
  deps.claim = vi.fn(async id => { await original(id); throw Error("lost claim response"); });
  await expect(dispatchReplyAttempt(attemptId, deps, signal())).rejects.toThrow();
  deps.claim = original;
  const result = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(result.kind).toBe("settled"); if (result.kind === "settled") expect(result.state).toBe("uncertain");
  expect(deps.send).not.toHaveBeenCalled();
});
it("refuses foreign dispatch and receipt identities", async () => {
  const deps = fixture(); deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "dispatch", attemptId: token, token, reply }));
  await expect(dispatchReplyAttempt(attemptId, deps, signal())).rejects.toThrow("identity"); expect(deps.send).not.toHaveBeenCalled();
});
// [Astra #4] skipped_ineligible: a fresh-at-marker recheck (item_current)
// found the item ineligible. This is a settled terminal outcome; the
// provider must never be called for it.
it("skipped_ineligible never reaches the provider", async () => {
  const deps = fixture();
  deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "existing", result: { attemptId, kind: "settled", state: "skipped_ineligible" } }));
  const result = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(result).toEqual({ attemptId, kind: "settled", state: "skipped_ineligible" });
  expect(deps.send).not.toHaveBeenCalled(); expect(deps.persist).not.toHaveBeenCalled();
});
// [Astra #4] confirmed_not_submitted: a proven-non-submit result
// (invalid_input/cancelled_before_dispatch). Reached via a real dispatch ->
// persist(not_attempted) round trip, never invented directly by claim().
it("confirmed_not_submitted is reached only via a real dispatch + not_attempted persist", async () => {
  const deps = fixture();
  deps.send = vi.fn<ReplyDispatchDependencies["send"]>(async () => ({ kind: "not_attempted", reason: "invalid_input" }));
  const result = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(result).toEqual({ attemptId, kind: "settled", state: "confirmed_not_submitted" });
  expect(deps.send).toHaveBeenCalledOnce();
});
// [Astra #4] busy/SENDER_BUSY: deferred, NOT complete, NOT journaled, no send.
it("a busy claim defers without sending or persisting", async () => {
  const deps = fixture();
  deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "deferred", attemptId }));
  const result = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(result).toEqual({ attemptId, kind: "deferred" });
  expect(deps.send).not.toHaveBeenCalled(); expect(deps.persist).not.toHaveBeenCalled();
});
// [Astra #3 / Astra B1] a revoked/expired requester never reaches the
// provider; worker_start_dispatch itself (folded authz, same statement as
// the marker write) reports not_sent before any token exists.
it("an unauthorized requester never reaches the provider", async () => {
  const deps = fixture();
  deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "not_sent", attemptId, reason: "requester_unauthorized" }));
  const result = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(result).toEqual({ attemptId, kind: "not_sent", reason: "requester_unauthorized" });
  expect(deps.send).not.toHaveBeenCalled(); expect(deps.persist).not.toHaveBeenCalled();
});
// [Astra #4] never-provider-on-unknown-commit: start_dispatch raised/returned
// ambiguously (STALE_CLAIM/WINDOW_EXPIRED/FROZEN_MISMATCH) after the marker
// attempt but before any token existed -> not_sent, no provider call.
// SENDER_BUSY is covered separately below as `deferred` (Astra B2).
it("an ambiguous/unknown start_dispatch commit never reaches the provider", async () => {
  const deps = fixture();
  deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "not_sent", attemptId, reason: "INBOX_REPLY_STALE_CLAIM" }));
  const result = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(result).toEqual({ attemptId, kind: "not_sent", reason: "INBOX_REPLY_STALE_CLAIM" });
  expect(deps.send).not.toHaveBeenCalled(); expect(deps.persist).not.toHaveBeenCalled();
});
// [Astra B2] SENDER_BUSY maps to `deferred`, the same retryable shape as a
// busy claim — NOT `not_sent`. Both are equally non-memoizable, but this
// keeps the reason vocabulary honest: SENDER_BUSY genuinely means "someone
// else is mid-flight right now", not "this requester/commit is invalid".
it("a sender-busy start_dispatch failure is reported as deferred, not not_sent", async () => {
  const deps = fixture();
  deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "deferred", attemptId }));
  const result = await dispatchReplyAttempt(attemptId, deps, signal());
  expect(result).toEqual({ attemptId, kind: "deferred" });
  expect(deps.send).not.toHaveBeenCalled(); expect(deps.persist).not.toHaveBeenCalled();
});
// Exhaustive translation: an out-of-vocabulary state from claim()/persist()
// must throw, never silently pass through (no ELSE, mirrors operation_status).
it("throws on an unmapped settled state rather than passing it through silently", async () => {
  const deps = fixture();
  deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "existing", result: { attemptId, kind: "settled", state: "made_up_state" as never } }));
  await expect(dispatchReplyAttempt(attemptId, deps, signal())).rejects.toThrow(/Unmapped reply attempt state/);
});
