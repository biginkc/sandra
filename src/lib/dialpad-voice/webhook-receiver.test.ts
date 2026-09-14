import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDialpadVoiceReceiver } from "./webhook-receiver";

const secret = "fixture-secret";
function request(payload: object, key = secret) {
  const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key).update(`${header}.${body}`).digest("base64url");
  return new Request("https://example.test/voice", { method: "POST", body: `${header}.${body}.${sig}` });
}
const event = { call_id: "123", state: "hangup", target: { id: "456", type: "user" } };
describe("voice webhook durable acknowledgment", () => {
  it("waits for storage and supplies exact string identity and dedupe digest", async () => {
    let resolve!: () => void;
    const persist = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    let finished = false;
    const receiver = createDialpadVoiceReceiver({ secret, providerUserId: "456", persist });
    const result = receiver(request(event)).then((r) => { finished = true; return r; });
    await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    expect(persist.mock.calls[0]).toEqual([expect.objectContaining({ providerCallId: "123", envelopeHash: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    resolve();
    expect((await result).status).toBe(200);
  });
  it("retries database failure instead of acknowledging data loss", async () => {
    const receive = createDialpadVoiceReceiver({ secret, providerUserId: "456", persist: async () => { throw Error("private DB details"); } });
    const response = await receive(request(event));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
  it("rejects forged deliveries and ignores another user without persistence", async () => {
    const persist = vi.fn();
    const receive = createDialpadVoiceReceiver({ secret, providerUserId: "456", persist });
    expect((await receive(request(event, "wrong"))).status).toBe(401);
    expect((await receive(request({ ...event, target: { id: "789", type: "user" } }))).status).toBe(204);
    expect(persist).not.toHaveBeenCalled();
  });
  it("retains missing target for reconciliation without inventing lead attribution", async () => {
    const persist = vi.fn();
    const receive = createDialpadVoiceReceiver({ secret, providerUserId: "456", persist });
    expect((await receive(request({ call_id: "123", state: "recording" }))).status).toBe(200);
    expect(persist.mock.calls[0][0].payload).not.toHaveProperty("target");
  });
  it("retains matching users with documented casing or incomplete target metadata", async () => {
    const persist = vi.fn();
    const receive = createDialpadVoiceReceiver({ secret, providerUserId: "456", persist });
    for (const target of [{ id: "456", type: "User" }, { id: "456" }, { id: "456", type: "future-type" }]) {
      expect((await receive(request({ ...event, target }))).status).toBe(200);
    }
    expect(persist).toHaveBeenCalledTimes(3);
  });
  it("rejects unsafe numeric IDs and oversized bodies", async () => {
    const persist = vi.fn();
    const receive = createDialpadVoiceReceiver({ secret, providerUserId: "456", persist });
    expect((await receive(request({ ...event, call_id: Number.MAX_SAFE_INTEGER + 1 }))).status).toBe(400);
    expect((await receive(new Request("https://example.test", { method: "POST", body: "x".repeat(1_048_577) }))).status).toBe(413);
    expect(persist).not.toHaveBeenCalled();
  });
});

it('configured company receiver retains both reps after signature verification',async()=>{const persist=vi.fn();const receive=createDialpadVoiceReceiver({secret,persist});for(const id of ['456','789'])expect((await receive(request({...event,target:{id,type:'user'}}))).status).toBe(200);expect(persist).toHaveBeenCalledTimes(2);});
