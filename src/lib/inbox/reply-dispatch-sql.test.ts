import { expect, it, vi } from "vitest";
import { createReplyDispatchSqlAdapter, type ReplyDispatchQueryExecutor } from "./reply-dispatch-sql";
import { dispatchReplyAttempt } from "./reply-dispatch";

const orgId = "11111111-1111-1111-1111-111111111111", operationId = "22222222-2222-2222-2222-222222222222", attemptId = "33333333-3333-3333-3333-333333333333";

function fakeExecutor(handlers: Record<string, (params: unknown[]) => unknown>): ReplyDispatchQueryExecutor {
  return {
    async query<Row extends Record<string, unknown>>(statement: string, params: unknown[]) {
      for (const [needle, handler] of Object.entries(handlers)) {
        if (statement.includes(needle)) {
          const result = handler(params);
          if (result instanceof Error) throw result;
          return { rows: [{ result } as unknown as Row] };
        }
      }
      throw Error(`Unhandled statement in fake executor: ${statement}`);
    },
  };
}

it("happy path: claimed -> authorized -> dispatch -> send -> persist", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "claimed", generation: "1" }; },
    worker_authorize: () => { calls.push("authorize"); return undefined; },
    worker_start_dispatch: () => { calls.push("start_dispatch"); return { kind: "dispatch", token: "44444444-4444-4444-4444-444444444444", from: "+18165550001", to: "+18165550002", body: "hi" }; },
    worker_persist: () => { calls.push("persist"); return { state: "provider_accepted" }; },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "ext-1", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "settled", state: "provider_accepted" });
  expect(calls).toEqual(["claim", "authorize", "start_dispatch", "persist"]);
  expect(transport).toHaveBeenCalledOnce();
});

// [Astra #4] busy claim -> deferred, no authorize/start_dispatch/send call.
it("a busy claim defers before ever calling authorize", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "busy" }; },
    worker_authorize: () => { calls.push("authorize"); return undefined; },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "deferred" });
  expect(calls).toEqual(["claim"]);
  expect(transport).not.toHaveBeenCalled();
});

// [Astra #3] MUTATION: a broken adapter that skips the authorize() call
// entirely would let a revoked requester's dispatch through to the provider.
// First show the guard's absence is unsafe, then show the real adapter
// (which always calls worker_authorize before start_dispatch) blocks it.
it("mutation: without the authorize call, a revoked requester would reach the provider — the real adapter never lets that happen", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "claimed", generation: "1" }; },
    worker_authorize: () => { calls.push("authorize"); return new Error("INBOX_ACTION_FORBIDDEN"); },
    worker_start_dispatch: () => { calls.push("start_dispatch"); return { kind: "dispatch", token: "44444444-4444-4444-4444-444444444444", from: "+18165550001", to: "+18165550002", body: "hi" }; },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "not_sent", reason: "requester_unauthorized" });
  // The real adapter's claim() always calls worker_authorize BEFORE
  // worker_start_dispatch, and stops there on a raise — start_dispatch is
  // never reached, and the mocked provider was never invoked.
  expect(calls).toEqual(["claim", "authorize"]);
  expect(transport).not.toHaveBeenCalled();
});

// [Astra #4] never-provider-on-unknown-commit: start_dispatch throws ->
// not_sent, provider never called, even though authorize already passed.
it("an unknown start_dispatch commit never reaches the provider", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "claimed", generation: "1" }; },
    worker_authorize: () => { calls.push("authorize"); return undefined; },
    worker_start_dispatch: () => { calls.push("start_dispatch"); return new Error("INBOX_REPLY_STALE_CLAIM"); },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "not_sent", reason: "INBOX_REPLY_STALE_CLAIM" });
  expect(calls).toEqual(["claim", "authorize", "start_dispatch"]);
  expect(transport).not.toHaveBeenCalled();
});

it("skipped_ineligible from start_dispatch never reaches the provider", async () => {
  const executor = fakeExecutor({
    worker_claim: () => ({ kind: "claimed", generation: "1" }),
    worker_authorize: () => undefined,
    worker_start_dispatch: () => ({ kind: "skipped", reason: "conversation_window_expired" }),
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "settled", state: "skipped_ineligible" });
  expect(transport).not.toHaveBeenCalled();
});

it("existing re-entry (uncertain after a crash) never re-claims a token", async () => {
  const executor = fakeExecutor({ worker_claim: () => ({ kind: "existing", state: "uncertain" }) });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "settled", state: "uncertain" });
  expect(transport).not.toHaveBeenCalled();
});
