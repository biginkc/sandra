import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleInboundCall, parseInboundCall } from "./inbound";
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
const valid = { inbound: true, call_id: "inbound-1", from: "+18165551001", to: "+18165551002", completed: true };
const secret = "synthetic-only";
const signed = (payload: unknown) => {
  const body = JSON.stringify(payload);
  return new Request("https://synthetic.invalid/inbound", { method: "POST", body, headers: { "x-webhook-signature": createHmac("sha256", secret).update(body).digest("hex") } });
};
describe("inbound contract", () => {
  it("retains minimal identities without tenant metadata or provider URL", () => {
    expect(parseInboundCall({ ...valid, metadata: { org_id: "attacker" }, recording_url: "https://private.invalid/audio", transcript: "private" })).toEqual({
      callId: "inbound-1", from: valid.from, to: valid.to, completed: true, recordingState: "reported_available",
    });
  });
  it.each([{ inbound: false }, { inbound: undefined }, { is_proxy_agent_call: true }, { call_id: "../elsewhere" }, { from: "blocked" }, { to: "8165551002" }, { completed: "true" }])("rejects unsafe or ambiguous inbound shape %j", (delta) => {
    expect(parseInboundCall({ ...valid, ...delta })).toBeNull();
  });
  it("distinguishes absent recording from explicitly disabled recording", () => {
    expect(parseInboundCall(valid)?.recordingState).toBe("pending");
    expect(parseInboundCall({ ...valid, record: false })?.recordingState).toBe("not_recorded");
  });
  it("accepts repeated authenticated events through the idempotent sink", async () => {
    const ingest = vi.fn().mockResolvedValue("stored-id");
    for (let i = 0; i < 2; i++) expect((await handleInboundCall(signed(valid), { secret, ingest })).status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(2);
  });
  it("does not ingest missing or invalid signatures", async () => {
    const ingest = vi.fn();
    expect((await handleInboundCall(signed(valid), { secret: "wrong", ingest })).status).toBe(401);
    expect((await handleInboundCall(signed(valid), { secret: undefined, ingest })).status).toBe(503);
    expect(ingest).not.toHaveBeenCalled();
  });
  it("keeps unknown destinations retryable and redacts infrastructure errors", async () => {
    expect((await handleInboundCall(signed(valid), { secret, ingest: async () => null })).status).toBe(503);
    const result = await handleInboundCall(signed(valid), { secret, ingest: async () => { throw new Error("private details"); } });
    expect(result).toEqual({ status: 500, body: { error: "ingestion_failed" } });
  });
  it("preserves the bounded body rejection", async () => {
    const ingest = vi.fn();
    const request = new Request("https://synthetic.invalid", { method: "POST", body: "{}", headers: { "content-length": String(4 * 1024 * 1024 + 1) } });
    expect((await handleInboundCall(request, { secret, ingest })).status).toBe(413);
    expect(ingest).not.toHaveBeenCalled();
  });
});
