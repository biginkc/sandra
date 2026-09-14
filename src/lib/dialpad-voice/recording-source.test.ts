import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { DialpadVoiceDatabase } from "./database.generated";
import { signedRecordingUrl } from "./recording-source";
const options = { orgId: "org", callId: "123", providerUserId: "456", recordingId: "segment", providerCompanyId:"company", recordingKind: "admincallrecording" };
const event = (timestamp: number, url: string, patch = {}) => ({org_id:"org",webhook_source_id:"source",status:"processed", payload: {
  call_id: "123", state: "recording", event_timestamp: timestamp, target: { id: "456", type: "User" },
  recording_details: [{ id: "segment", recording_type: "admincallrecording", url }], ...patch,
} });
function setup(rows: unknown[], failed = false, company = 'company') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async input=>{const path=new URL(String(input)).pathname;
    if(path.endsWith('dialpad_voice_webhook_sources'))return Response.json({id:'source',org_id:'org',connection_id:'connection',connection_version:1});
    if(path.endsWith('dialpad_connection_revisions'))return Response.json({org_id:'org',connection_id:'connection',config_version:1,provider_company_id:company});
    return Response.json(failed ? { message: "private" } : rows, { status: failed ? 500 : 200 });});
  const client = createClient<DialpadVoiceDatabase>("https://fixture.test", "key", { auth: { persistSession: false }, global: { fetch: fetcher } });
  return { fetcher, run: () => signedRecordingUrl(client, options) };
}
describe("signed recording URL selection", () => {
  it("uses provider event time rather than delivery order and scopes its bounded lookup", async () => {
    const h = setup([event(100, "older"), event(200, "fresh")]);
    expect(await h.run()).toBe("fresh");
    const url = new URL(String(h.fetcher.mock.calls[0][0]));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ org_id: "eq.org", "payload->>call_id": "eq.123", "payload->>state": "eq.recording", limit: "20" });
  });
  it("rejects wrong call, user, state and segment without manufacturing a replacement URL", async () => {
    const h = setup([
      event(500, "wrong", { call_id: "999" }), event(500, "wrong", { target: { id: "999", type: "User" } }),
      event(500, "wrong", { state: "hangup" }), event(500, "wrong", { recording_details: [{ id: "different", recording_type: "admincallrecording", url: "wrong" }] }),
      { payload: "malformed" },
    ]);
    expect(await h.run()).toBeNull();
  });
  it("does not treat a database error as absence of an event URL", async () => {
    await expect(setup([], true).run()).rejects.toThrow("Signed recording source unavailable");
  });
});

it('ignores legacy and quarantined receipt URLs',async()=>{expect(await setup([{...event(100,'bad'),webhook_source_id:null},{...event(200,'bad'),status:'quarantined'}]).run()).toBeNull();});

it('rejects a signed source from a different historical provider company',async()=>{expect(await setup([event(100,'foreign')],false,'foreign-company').run()).toBeNull();});
