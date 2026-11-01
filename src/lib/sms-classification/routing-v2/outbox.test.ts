import { describe, expect, it, vi } from "vitest";
import { deliverV2Outbox, type V2OutboxDeps, type V2OutboxIntent } from "./outbox";
const intent: V2OutboxIntent = { id: "outbox-1", orgId: "org", propertyId: "prop", inboundMessageId: "inbound", kind: "reply", payload: {} };
function fixture() {
  let status = "pending";
  const send = vi.fn(async () => ({ kind: "accepted" as const, receiptId: "provider-1" }));
  const deps: V2OutboxDeps = {
    prepare: vi.fn(async () => ({ kind: "ready" as const, send })),
    claim: vi.fn(async () => { if (status !== "pending") return "not_pending"; status = "claimed"; return "ok"; }),
    authorize: vi.fn(async () => "ok"),
    accepted: vi.fn(async () => { status = "sent"; }),
    reconcile: vi.fn(async () => {}), notSent: vi.fn(async () => {}),
  };
  return { deps, send };
}
describe("v2 outbox delivery", () => {
  it("concurrent consumers send once using the durable intent identity", async () => {
    const { deps, send } = fixture();
    const results = await Promise.all([deliverV2Outbox(intent, deps), deliverV2Outbox(intent, deps)]);
    expect(results.map((r) => r.kind).sort()).toEqual(["sent", "skipped"]);
    expect(send).toHaveBeenCalledExactlyOnceWith("outbox-1");
    expect(deps.accepted).toHaveBeenCalledWith(intent, "provider-1");
  });
  it("quiet hours leaves the intent unclaimed for later delivery", async () => {
    const { deps, send } = fixture();
    deps.prepare = vi.fn(async () => ({ kind: "wait" as const, reason: "quiet_hours" }));
    expect(await deliverV2Outbox(intent, deps)).toEqual({ kind: "waiting", reason: "quiet_hours" });
    expect(deps.claim).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it.each(["flag_off", "suppressed", "human_takeover", "superseded", "not_claimed"])("final fence %s prevents delivery after preparation", async (reason) => {
    const { deps, send } = fixture();
    deps.authorize = vi.fn(async () => reason);
    expect(await deliverV2Outbox(intent, deps)).toEqual({ kind: "skipped", reason });
    expect(send).not.toHaveBeenCalled(); expect(deps.accepted).not.toHaveBeenCalled();
  });
  it("unknown provider result is never retried by another consumer", async () => {
    const { deps, send } = fixture();
    send.mockRejectedValue(new Error("network lost"));
    expect(await deliverV2Outbox(intent, deps)).toEqual({ kind: "reconcile", reason: "provider_outcome_unknown" });
    expect((await deliverV2Outbox(intent, deps)).kind).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1); expect(deps.accepted).not.toHaveBeenCalled();
  });
  it("failed acceptance persistence is reconciled, not reported sent", async () => {
    const { deps, send } = fixture();
    vi.mocked(deps.accepted).mockRejectedValue(new Error("db unavailable"));
    expect(await deliverV2Outbox(intent, deps)).toEqual({ kind: "reconcile", reason: "acceptance_record_failed" });
    await deliverV2Outbox(intent, deps);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("lost authorization response never reaches the provider", async () => {
    const { deps, send } = fixture();
    vi.mocked(deps.authorize).mockRejectedValue(new Error("timeout"));
    expect(await deliverV2Outbox(intent, deps)).toEqual({ kind: "reconcile", reason: "authorization_unknown" });
    expect(send).not.toHaveBeenCalled();
  });
  it("an already-authorized intent needs reconciliation", async () => {
    const { deps, send } = fixture();
    vi.mocked(deps.authorize).mockResolvedValue("already_authorized");
    expect(await deliverV2Outbox(intent, deps)).toEqual({ kind: "reconcile", reason: "already_authorized" });
    expect(send).not.toHaveBeenCalled();
  });
});
