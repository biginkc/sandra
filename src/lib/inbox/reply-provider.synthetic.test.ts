import { beforeEach, describe, expect, it } from "vitest";

import type { ReplyProviderResult } from "./reply-provider";
import {
  buildSyntheticReplyCallback,
  createSyntheticReplyTransport,
  getSyntheticReplyLog,
  registerSyntheticReplyOverride,
  resetSyntheticReplyState,
} from "./reply-provider.synthetic";

const reply = { from: "+18165550001", to: "+18165550002", body: "Exact approved text" };
const signal = () => new AbortController().signal;

// Mutation-first union byte-match: every member of the real ReplyProviderResult
// union must be producible, with exactly the same shape, by the synthetic
// double — checked by TypeScript structural assignability (this assignment
// fails to compile if the synthetic ever drifts from the real union) AND at
// runtime below.
function assertRealUnionMember(result: ReplyProviderResult): void {
  expect(["accepted", "not_attempted", "uncertain"]).toContain(result.kind);
}

beforeEach(() => resetSyntheticReplyState());

describe("createSyntheticReplyTransport", () => {
  it("defaults to accepted with a synthetic externalId, matching the real union shape", async () => {
    const send = createSyntheticReplyTransport("synthetic-key");
    const result = await send(reply, signal());
    assertRealUnionMember(result);
    expect(result).toEqual({ kind: "accepted", provider: "sendillo", externalId: expect.stringMatching(/^synthetic_/) as unknown as string, providerStatus: "sent" });
  });

  it("logs every send for test introspection", async () => {
    const send = createSyntheticReplyTransport("synthetic-key");
    await send(reply, signal());
    const log = getSyntheticReplyLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ from: reply.from, to: reply.to, body: reply.body });
  });

  it("does not call the transport for invalid or already-cancelled input", async () => {
    const send = createSyntheticReplyTransport("synthetic-key");
    const invalid = await send({ ...reply, body: "x".repeat(1601) }, signal());
    assertRealUnionMember(invalid);
    expect(invalid.kind).toBe("not_attempted");
    const abort = new AbortController();
    abort.abort();
    const cancelled = await send(reply, abort.signal);
    assertRealUnionMember(cancelled);
    expect(cancelled.kind).toBe("not_attempted");
  });

  it("honors a one-shot override per destination, then reverts to accepted", async () => {
    registerSyntheticReplyOverride(reply.to, { kind: "uncertain", reason: "transport_or_timeout" });
    const send = createSyntheticReplyTransport("synthetic-key");
    const first = await send(reply, signal());
    assertRealUnionMember(first);
    expect(first).toEqual({ kind: "uncertain", reason: "transport_or_timeout" });
    const second = await send(reply, signal());
    assertRealUnionMember(second);
    expect(second.kind).toBe("accepted");
  });

  it("supports a forced uncertain-with-reportedExternalId override (contradictory_response shape)", async () => {
    registerSyntheticReplyOverride(reply.to, { kind: "uncertain", reason: "contradictory_response", reportedExternalId: "PROV-REPORTED-1" });
    const send = createSyntheticReplyTransport("synthetic-key");
    const result = await send(reply, signal());
    assertRealUnionMember(result);
    expect(result).toEqual({ kind: "uncertain", reason: "contradictory_response", reportedExternalId: "PROV-REPORTED-1" });
  });

  it("supports a forced not_attempted override", async () => {
    registerSyntheticReplyOverride(reply.to, { kind: "not_attempted", reason: "cancelled_before_dispatch" });
    const send = createSyntheticReplyTransport("synthetic-key");
    const result = await send(reply, signal());
    assertRealUnionMember(result);
    expect(result).toEqual({ kind: "not_attempted", reason: "cancelled_before_dispatch" });
  });

  it("throws on missing/invalid apiKey, matching the real factory's guard", () => {
    expect(() => createSyntheticReplyTransport("")).toThrow();
    expect(() => createSyntheticReplyTransport("bad\nkey")).toThrow();
  });
});

describe("buildSyntheticReplyCallback", () => {
  it("emits the envelope shape the ingress route's parser expects", () => {
    expect(buildSyntheticReplyCallback("PROV-1", "delivered")).toEqual({ event: "message.delivered", data: { messageId: "PROV-1" } });
    expect(buildSyntheticReplyCallback("PROV-2", "delivery_failed")).toEqual({ event: "message.failed", data: { messageId: "PROV-2" } });
  });

  it("round-trips a synthetic accept's externalId into a reconcilable callback payload", async () => {
    const send = createSyntheticReplyTransport("synthetic-key");
    const accepted = await send(reply, signal());
    if (accepted.kind !== "accepted") throw new Error("expected accepted");
    const callback = buildSyntheticReplyCallback(accepted.externalId, "delivered");
    expect(callback.data.messageId).toBe(accepted.externalId);
  });
});
