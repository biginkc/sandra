import { expect, it, vi } from "vitest";
import { dispatchReplyAttempt, type ReplyDispatchDependencies, type ReplyAttemptResult } from "./reply-dispatch";
const attemptId = "11111111-1111-1111-1111-111111111111", token = "22222222-2222-2222-2222-222222222222";
const reply = { from: "+18165550001", to: "+18165550002", body: "Approved text" };
function fixture() {
  let marker = false, stored: ReplyAttemptResult | undefined;
  const deps: ReplyDispatchDependencies = {
    claim: vi.fn<ReplyDispatchDependencies["claim"]>(async () => {
      if (marker) return { kind: "existing", result: stored ?? { attemptId, state: "uncertain" } };
      marker = true; return { kind: "dispatch", attemptId, token, reply };
    }),
    send: vi.fn<ReplyDispatchDependencies["send"]>(async () => ({ kind: "accepted", provider: "sendillo", externalId: "owned-reference", providerStatus: "accepted" })),
    persist: vi.fn(async (_id, _token, result) => {
      stored = { attemptId, state: result.kind === "accepted" ? "accepted" : result.kind === "not_attempted" ? "not_attempted" : "uncertain" };
      return stored;
    }),
  };
  return deps;
}
const signal = () => new AbortController().signal;
it("duplicate delivery reconciles the receipt with only one provider call", async () => {
  const deps = fixture();
  expect(await dispatchReplyAttempt(attemptId, deps, signal())).toEqual({ attemptId, state: "accepted" });
  expect(await dispatchReplyAttempt(attemptId, deps, signal())).toEqual({ attemptId, state: "accepted" });
  expect(deps.send).toHaveBeenCalledOnce();
});
it("lost acceptance persistence cannot trigger a second send on durable replay", async () => {
  const deps = fixture(); deps.persist = vi.fn(async () => { throw Error("lost receipt connection"); });
  await expect(dispatchReplyAttempt(attemptId, deps, signal())).rejects.toThrow("lost receipt connection");
  expect(await dispatchReplyAttempt(attemptId, deps, signal())).toEqual({ attemptId, state: "uncertain" });
  expect(deps.send).toHaveBeenCalledOnce();
});
it("a thrown transport is persisted as uncertain and not retried", async () => {
  const deps = fixture(); deps.send = vi.fn(async () => { throw Error("transport lost"); });
  expect((await dispatchReplyAttempt(attemptId, deps, signal())).state).toBe("uncertain");
  expect((await dispatchReplyAttempt(attemptId, deps, signal())).state).toBe("uncertain"); expect(deps.send).toHaveBeenCalledOnce();
});
it("a lost claim response never reaches the provider", async () => {
  const deps = fixture(), original = deps.claim;
  deps.claim = vi.fn(async id => { await original(id); throw Error("lost claim response"); });
  await expect(dispatchReplyAttempt(attemptId, deps, signal())).rejects.toThrow();
  deps.claim = original; expect((await dispatchReplyAttempt(attemptId, deps, signal())).state).toBe("uncertain"); expect(deps.send).not.toHaveBeenCalled();
});
it("refuses foreign dispatch and receipt identities", async () => {
  const deps = fixture(); deps.claim = vi.fn<ReplyDispatchDependencies["claim"]>(async () => ({ kind: "dispatch", attemptId: token, token, reply }));
  await expect(dispatchReplyAttempt(attemptId, deps, signal())).rejects.toThrow("identity"); expect(deps.send).not.toHaveBeenCalled();
});
