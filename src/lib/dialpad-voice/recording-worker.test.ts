import { HistoricalConnectionError } from "./historical-connection";
import { DialpadVoiceError } from "./client";
import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialpadVoiceDatabase } from "./database.generated";
import { processDialpadRecording } from "./recording-worker";
import { retainDialpadRecording } from "./recording-storage";

vi.mock("./recording-storage", () => ({ retainDialpadRecording: vi.fn() }));
beforeEach(() => vi.mocked(retainDialpadRecording).mockReset());
function fixture(callResponse?: Response, mediaResponse?: Response | ((url: string) => Response), eventUrl?: string) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const client = createClient<DialpadVoiceDatabase>("https://example.test", "fixture-key", {
    auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      writes.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      if (path.endsWith("fn_claim_dialpad_recording")) return Response.json([{
        id: "artifact", org_id: "org", provider_call_id: "123", provider_recording_id: "segment",
        recording_kind: "admincallrecording", intent_id: "intent", status: "processing", lease_token: "lease", attempt_count: 1,
      }]);
      if (path.endsWith("fn_defer_dialpad_detail_budget")) return Response.json(null);
      if(path.endsWith('dialpad_voice_webhook_sources'))return Response.json({id:'source',org_id:'org',connection_id:'connection',connection_version:1});
      if(path.endsWith('dialpad_connection_revisions'))return Response.json({org_id:'org',connection_id:'connection',config_version:1,provider_company_id:'company'});
      if (path.endsWith("dialpad_voice_event_inbox")) return Response.json(eventUrl ? [{org_id:"org",webhook_source_id:"source",status:"processed", payload: {
        call_id: "123", state: "recording", event_timestamp: 200, target: { id: "456", type: "User" },
        recording_details: [{ id: "segment", recording_type: "admincallrecording", url: eventUrl }],
      } }] : []);
      return Response.json([{ id: "artifact" }]);
    } },
  });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).includes("/api/v2/")) return callResponse ?? Response.json({
      call_id: "123", target: { id: "456", type: "User" },
      recording_details: [{ id: "segment", url: "https://dialpad.com/blob/adminrecording/segment", recording_type: "admincallrecording" }],
    });
    return typeof mediaResponse === "function" ? mediaResponse(String(input)) : mediaResponse ?? new Response(null, { status: 302, headers: { location: "/login" } });
  });
  const decode = vi.fn().mockResolvedValue({ durationSeconds: 1, channels: 1, sampleRate: 16000 });
  const resolveConnection = vi.fn().mockResolvedValue({providerUserId:"456",providerCompanyId:"company",apiKey:"fixture-key"});
  const run = () => processDialpadRecording({ client, orgId: "org", resolveConnection, bucket: "private", decode, fetchImpl });
  return { run, writes, fetchImpl, decode, resolveConnection };
}
describe("recording job orchestration", () => {
  it("marks login redirects denied without decoding, uploading or claiming success", async () => {
    const { run, writes, decode } = fixture();
    expect(await run()).toBe("denied");
    expect(writes.at(-1)?.body).toMatchObject({ status: "denied", last_error_code: "recording_login_required" });
    expect(decode).not.toHaveBeenCalled();
    expect(retainDialpadRecording).not.toHaveBeenCalled();
  });
  it("refuses a different user's call before fetching audio", async () => {
    const { run, fetchImpl } = fixture(Response.json({ call_id: "123", target: { id: "789", type: "user" } }));
    expect(await run()).toBe("denied");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("defers the shared detail budget on provider429", async () => {
    const { run, writes } = fixture(new Response(null, { status: 429 }));
    expect(await run()).toBe("retry");
    expect(writes.find((w) => w.path.endsWith("fn_defer_dialpad_detail_budget"))?.body).toEqual({ p_org_id: "org", p_seconds: 60 });
  });
  it("requires retained storage success after successful decode", async () => {
    const bytes = Buffer.from("RIFF0000WAVEdata");
    const first = fixture(undefined, new Response(bytes, { headers: { "content-type": "audio/wav" } }));
    vi.mocked(retainDialpadRecording).mockResolvedValueOnce({ ok: false, reason: "readback_mismatch" });
    expect(await first.run()).toBe("retry");
    const second = fixture(undefined, new Response(bytes, { headers: { "content-type": "audio/wav" } }));
    vi.mocked(retainDialpadRecording).mockResolvedValueOnce({ ok: true, storagePath: "owned", verifiedAt: "now" });
    expect(await second.run()).toBe("available");
    expect(second.writes.map(r => r.path)).toEqual(["/rest/v1/rpc/fn_claim_dialpad_recording", "/rest/v1/dialpad_voice_event_inbox"]); // Storage helper owns availability CAS.
  });
  it("queues additional automatic segments from the verified call before retaining the claimed segment", async () => {
    const h = fixture(Response.json({
      call_id: "123", target: { id: "456", type: "User" },
      recording_details: [
        { id: "segment", recording_type: "admincallrecording", url: "https://dialpad.com/blob/adminrecording/segment" },
        { id: "second", recording_type: "admincallrecording", url: "https://dialpad.com/blob/adminrecording/second" },
        { id: "manual", recording_type: "callrecording", url: "https://dialpad.com/blob/callrecording/manual" },
      ],
    }), new Response(Buffer.from("RIFF0000WAVEdata"), { headers: { "content-type": "audio/wav" } }));
    vi.mocked(retainDialpadRecording).mockResolvedValueOnce({ ok: true, storagePath: "owned", verifiedAt: "now" });
    expect(await h.run()).toBe("available");
    const queue = h.writes.find((write) => write.path.endsWith("dialpad_recording_artifacts"));
    expect(queue?.body).toEqual([{
      org_id: "org", provider_call_id: "123", provider_recording_id: "second",
      recording_kind: "admincallrecording", intent_id: "intent", status: "pending",
    }]);
  });
  it("downloads the matching signed-event URL instead of the stale Call Get URL", async () => {
    const fresh = "https://dialpad.com/secureblob/callrecording/segment?token=fresh";
    const h = fixture(undefined, new Response(Buffer.from("RIFF0000WAVEdata"), { headers: { "content-type": "audio/wav" } }), fresh);
    vi.mocked(retainDialpadRecording).mockResolvedValueOnce({ ok: true, storagePath: "owned", verifiedAt: "now" });
    expect(await h.run()).toBe("available");
    expect(String(h.fetchImpl.mock.calls[1][0])).toBe(fresh);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("uses a distinct current REST URL when the saved event link has expired", async () => {
    const expired = "https://dialpad.com/secureblob/callrecording/segment?token=expired";
    const h = fixture(undefined, url => url === expired ? new Response(null, { status: 403 })
      : new Response(Buffer.from("RIFF0000WAVEdata"), { headers: { "content-type": "audio/wav" } }), expired);
    vi.mocked(retainDialpadRecording).mockResolvedValueOnce({ ok: true, storagePath: "owned", verifiedAt: "now" });
    expect(await h.run()).toBe("available");
    expect(h.fetchImpl.mock.calls.slice(1).map(([url]) => String(url))).toEqual([expired, "https://dialpad.com/blob/adminrecording/segment"]);
  });
  it("rejects an unsupported event URL without suppressing a valid REST source", async () => {
    const unsupported = "https://untrusted.example/recording";
    const h = fixture(undefined, new Response(Buffer.from("RIFF0000WAVEdata"), { headers: { "content-type": "audio/wav" } }), unsupported);
    vi.mocked(retainDialpadRecording).mockResolvedValueOnce({ ok: true, storagePath: "owned", verifiedAt: "now" });
    expect(await h.run()).toBe("available");
    expect(h.fetchImpl.mock.calls.slice(1).map(([url]) => String(url))).toEqual(["https://dialpad.com/blob/adminrecording/segment"]);
  });

});

it('retries transient historical company verification429 without downloading',async()=>{const f=fixture();f.resolveConnection.mockRejectedValue(new DialpadVoiceError('http',429));expect(await f.run()).toBe('retry');expect(f.fetchImpl).not.toHaveBeenCalled();expect(f.writes.some(w=>w.path.endsWith('fn_defer_dialpad_detail_budget'))).toBe(true);});
it('denies missing historical binding without default provider fallback',async()=>{const f=fixture();f.resolveConnection.mockRejectedValue(new HistoricalConnectionError('history_unavailable'));expect(await f.run()).toBe('denied');expect(f.fetchImpl).not.toHaveBeenCalled();});
it('retries historical DB failures without media fetch',async()=>{const f=fixture();f.resolveConnection.mockRejectedValue(new HistoricalConnectionError('history_read_unavailable'));expect(await f.run()).toBe('retry');expect(f.fetchImpl).not.toHaveBeenCalled();});
