import { describe, expect, it, vi } from "vitest";
import { InboxHttpError } from "./http-error";
import { decodeInboxWorksetUpdate, probeInboxWorksetUpdates, type InboxWorksetUpdateRpcClient } from "./workset-updates";

const scope = "11111111-1111-4111-8111-111111111111";
const org = "22222222-2222-4222-8222-222222222222";
const user = "33333333-3333-4333-8333-333333333333";
const session = "44444444-4444-4444-8444-444444444444";
const base = {
  scope_id: scope,
  org_id: org,
  requester_id: user,
  session_id: session,
  access_epoch: "7",
  generation: "12",
  has_updates: false,
  refresh_required: false,
};

function client(data: unknown): InboxWorksetUpdateRpcClient {
  return { rpc: vi.fn(() => ({ abortSignal: vi.fn(async () => ({ data, error: null })) })) } as unknown as InboxWorksetUpdateRpcClient;
}

describe("inbox workset update probe", () => {
  it("decodes the identity-bound no-change response", async () => {
    const rpc = client(base);
    const result = await probeInboxWorksetUpdates(rpc, scope, new AbortController().signal);
    expect(result).toEqual({ scopeId: scope, orgId: org, requesterId: user, sessionId: session, accessEpoch: "7", generation: "12", hasUpdates: false, refreshRequired: false });
    expect(rpc.rpc).toHaveBeenCalledWith("inbox_probe_workset_updates", { scope_id: scope });
  });

  it("preserves a pre-upgrade scope as refresh-required, never as an update", () => {
    expect(decodeInboxWorksetUpdate({ ...base, refresh_required: true })).toMatchObject({ refreshRequired: true, hasUpdates: false });
    expect(() => decodeInboxWorksetUpdate({ ...base, refresh_required: true, has_updates: true })).toThrow(InboxHttpError);
  });

  it("rejects malformed or over-posted server responses", () => {
    expect(() => decodeInboxWorksetUpdate({ ...base, unexpected: true })).toThrow(InboxHttpError);
    expect(() => decodeInboxWorksetUpdate({ ...base, generation: 12 })).toThrow(InboxHttpError);
    expect(() => decodeInboxWorksetUpdate({ ...base, access_epoch: "01" })).toThrow(InboxHttpError);
  });

  it("rejects a malformed scope before invoking the RPC", async () => {
    const rpc = client(base);
    await expect(probeInboxWorksetUpdates(rpc, "not-a-uuid", new AbortController().signal)).rejects.toMatchObject({ status: 400 });
    expect(rpc.rpc).not.toHaveBeenCalled();
  });
});
