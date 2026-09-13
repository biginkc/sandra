import { createClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DialpadVoiceDatabase } from "./database.generated";
import { processDialpadRecording } from "./recording-worker";
import { retainDialpadRecording } from "./recording-storage";

vi.mock("./recording-storage", () => ({ retainDialpadRecording: vi.fn() }));
beforeEach(() => vi.mocked(retainDialpadRecording).mockReset());
function fixture(callResponse?: Response, mediaResponse?: Response) {
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const client = createClient<DialpadVoiceDatabase>("https://example.test", "fixture-key", {
    auth: { persistSession: false }, global: { fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      writes.push({ path, body: JSON.parse(String(init?.body ?? "{}")) });
      if (path.endsWith("fn_claim_dialpad_recording")) return Response.json([{
        id: "artifact", org_id: "org", provider_call_id: "123", provider_recording_id: "segment",
        recording_kind: "admincallrecording", status: "processing", lease_token: "lease", attempt_count: 1,
      }]);
      if (path.endsWith("fn_defer_dialpad_detail_budget")) return Response.json(null);
      return Response.json([{ id: "artifact" }]);
    } },
  });
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).includes("/api/v2/")) return callResponse ?? Response.json({
      call_id: "123", target: { id: "456", type: "User" },
      recording_details: [{ id: "segment", url: "https://dialpad.com/blob/adminrecording/segment", recording_type: "admincallrecording" }],
    });
    return mediaResponse ?? new Response(null, { status: 302, headers: { location: "/login" } });
  });
  const decode = vi.fn().mockResolvedValue({ durationSeconds: 1, channels: 1, sampleRate: 16000 });
  const run = () => processDialpadRecording({ client, orgId: "org", providerUserId: "456", apiKey: "fixture-key", bucket: "private", decode, fetchImpl });
  return { run, writes, fetchImpl, decode };
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
    expect(second.writes).toHaveLength(1); // Storage helper owns the availability CAS.
  });
});
