import { expect, it, vi } from "vitest";
import { createReplyDispatchSqlAdapter, type ReplyDispatchQueryExecutor } from "./reply-dispatch-sql";
import { dispatchReplyAttempt } from "./reply-dispatch";

// Ordinary behavioral tests of the JS control-flow only (fake executor, no
// real database). These do NOT stand in for the real mutation-first SQL
// proofs — those run against the actually-installed Postgres functions in
// experiments/inbox-reply-send-worker/proof.py (break the real guard, watch
// it fail, restore, watch it pass). This file only checks that the TS
// adapter dispatches the right statement in the right order and maps each
// result shape correctly.
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

it("happy path: claimed -> start_dispatch (folded authz) -> send -> persist", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "claimed", generation: "1" }; },
    worker_start_dispatch: () => { calls.push("start_dispatch"); return { kind: "dispatch", token: "44444444-4444-4444-4444-444444444444", from: "+18165550001", to: "+18165550002", body: "hi" }; },
    worker_persist: () => { calls.push("persist"); return { state: "provider_accepted" }; },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "ext-1", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "settled", state: "provider_accepted" });
  expect(calls).toEqual(["claim", "start_dispatch", "persist"]);
  expect(transport).toHaveBeenCalledOnce();
});

// [Astra B2] busy claim -> deferred, no start_dispatch call.
it("a busy claim defers before ever calling start_dispatch", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "busy" }; },
    worker_start_dispatch: () => { calls.push("start_dispatch"); return { kind: "dispatch", token: "44444444-4444-4444-4444-444444444444", from: "+18165550001", to: "+18165550002", body: "hi" }; },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "deferred" });
  expect(calls).toEqual(["claim"]);
  expect(transport).not.toHaveBeenCalled();
});

// [Astra B1] a revoked requester is caught by worker_start_dispatch itself
// (folded authz, same statement as the marker) — the adapter reports
// not_sent and never reaches the provider.
it("a revoked requester (raised from the folded worker_start_dispatch check) never reaches the provider", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "claimed", generation: "1" }; },
    worker_start_dispatch: () => { calls.push("start_dispatch"); return new Error("INBOX_REPLY_REQUESTER_UNAUTHORIZED"); },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "not_sent", reason: "INBOX_REPLY_REQUESTER_UNAUTHORIZED" });
  expect(calls).toEqual(["claim", "start_dispatch"]);
  expect(transport).not.toHaveBeenCalled();
});

// [Astra #4 + B2] a stale-generation/unknown-commit start_dispatch failure
// never reaches the provider; SENDER_BUSY specifically maps to `deferred`.
it("an unknown start_dispatch commit never reaches the provider", async () => {
  const calls: string[] = [];
  const executor = fakeExecutor({
    worker_claim: () => { calls.push("claim"); return { kind: "claimed", generation: "1" }; },
    worker_start_dispatch: () => { calls.push("start_dispatch"); return new Error("INBOX_REPLY_STALE_CLAIM"); },
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "not_sent", reason: "INBOX_REPLY_STALE_CLAIM" });
  expect(transport).not.toHaveBeenCalled();
});

it("a SENDER_BUSY start_dispatch failure maps to deferred, not not_sent", async () => {
  const executor = fakeExecutor({
    worker_claim: () => ({ kind: "claimed", generation: "1" }),
    worker_start_dispatch: () => new Error("INBOX_REPLY_SENDER_BUSY"),
  });
  const transport = vi.fn(async () => ({ kind: "accepted" as const, provider: "sendillo" as const, externalId: "x", providerStatus: "sent" }));
  const deps = createReplyDispatchSqlAdapter(executor, orgId, operationId, transport);
  const result = await dispatchReplyAttempt(attemptId, deps, new AbortController().signal);
  expect(result).toEqual({ attemptId, kind: "deferred" });
  expect(transport).not.toHaveBeenCalled();
});

it("skipped_ineligible from start_dispatch never reaches the provider", async () => {
  const executor = fakeExecutor({
    worker_claim: () => ({ kind: "claimed", generation: "1" }),
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
