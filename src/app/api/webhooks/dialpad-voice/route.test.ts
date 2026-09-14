import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { persistDialpadVoiceReceipt } from "@/lib/dialpad-voice/inbox";
import {loadDialpadWebhookSource} from "@/lib/dialpad-voice/webhook-source";
vi.mock("@/lib/dialpad-voice/webhook-source",()=>({loadDialpadWebhookSource:vi.fn()}));
import { POST } from "./route";

vi.mock("@/lib/dialpad-voice/inbox", () => ({ persistDialpadVoiceReceipt: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
const org = "11111111-1111-4111-8111-111111111111";
function configure() {
  vi.mocked(loadDialpadWebhookSource).mockResolvedValue({sourceId:org,orgId:org,secret:"fixture-secret"});
  vi.stubEnv("DIALPAD_VOICE_EVENTS_ENABLED", "true");
  vi.stubEnv("DIALPAD_VOICE_WEBHOOK_SOURCE_ID",org);
  vi.stubEnv("DIALPAD_VOICE_ORG_ID", org);
  vi.stubEnv("DIALPAD_VOICE_USER_ID", "456");
  vi.stubEnv("DIALPAD_VOICE_WEBHOOK_SECRET", "fixture-secret");
}
function signedRequest() {
  const h = Buffer.from('{"alg":"HS256"}').toString("base64url");
  const p = Buffer.from(JSON.stringify({ call_id: "123", state: "recording", org_id: "forged-org", target: { id: "456", type: "user" } })).toString("base64url");
  const s = createHmac("sha256", "fixture-secret").update(`${h}.${p}`).digest("base64url");
  return new Request("https://example.test/api/webhooks/dialpad-voice", { method: "POST", body: `${h}.${p}.${s}` });
}
describe("dedicated Dialpad voice endpoint", () => {
  it("is disabled by default", async () => {
    vi.stubEnv("DIALPAD_VOICE_EVENTS_ENABLED", "");
    expect((await POST(signedRequest())).status).toBe(404);
    expect(persistDialpadVoiceReceipt).not.toHaveBeenCalled();
  });
  it("uses configured tenancy after signature verification", async () => {
    configure();
    expect((await POST(signedRequest())).status).toBe(200);
    expect(persistDialpadVoiceReceipt).toHaveBeenCalledWith(org, expect.objectContaining({ providerCallId: "123" }),org);
  });
  it("does not acknowledge persistence failure", async () => {
    configure();
    vi.mocked(persistDialpadVoiceReceipt).mockRejectedValueOnce(Error("private"));
    expect((await POST(signedRequest())).status).toBe(503);
  });
  it("does not persist invalid signatures or missing source configuration", async () => {
    configure();
    expect((await POST(new Request("https://example.test", { method: "POST", body: "unsigned" }))).status).toBe(401);
    vi.mocked(loadDialpadWebhookSource).mockRejectedValueOnce(Error("source unavailable"));
    expect((await POST(signedRequest())).status).toBe(503);
    expect(persistDialpadVoiceReceipt).not.toHaveBeenCalled();
  });
});

it('accepts a delayed old signature only under its matched immutable source',async()=>{
 configure();const old='22222222-2222-4222-8222-222222222222';vi.stubEnv('DIALPAD_VOICE_WEBHOOK_PREVIOUS_SOURCE_IDS',old);
 vi.mocked(loadDialpadWebhookSource).mockImplementation(async id=>({sourceId:id,orgId:org,secret:id===org?'new-secret':'fixture-secret'}));
 expect((await POST(signedRequest())).status).toBe(200);
 expect(persistDialpadVoiceReceipt).toHaveBeenCalledExactlyOnceWith(org,expect.objectContaining({providerCallId:'123'}),old);
});
it('current signature uses only primary source while previous source remains configured',async()=>{
 configure();vi.stubEnv('DIALPAD_VOICE_WEBHOOK_PREVIOUS_SOURCE_IDS','22222222-2222-4222-8222-222222222222');
 expect((await POST(signedRequest())).status).toBe(200);expect(loadDialpadWebhookSource).toHaveBeenCalledTimes(1);
 expect(persistDialpadVoiceReceipt).toHaveBeenCalledExactlyOnceWith(org,expect.objectContaining({providerCallId:'123'}),org);
});
it('does not retry persistence using a second source',async()=>{
 configure();vi.stubEnv('DIALPAD_VOICE_WEBHOOK_PREVIOUS_SOURCE_IDS','22222222-2222-4222-8222-222222222222');vi.mocked(persistDialpadVoiceReceipt).mockRejectedValueOnce(Error('database unavailable'));
 expect((await POST(signedRequest())).status).toBe(503);expect(loadDialpadWebhookSource).toHaveBeenCalledTimes(1);expect(persistDialpadVoiceReceipt).toHaveBeenCalledTimes(1);
});
it('bounds rotation keys and rejects duplicate source IDs',async()=>{
 configure();vi.stubEnv('DIALPAD_VOICE_WEBHOOK_PREVIOUS_SOURCE_IDS',org);expect((await POST(signedRequest())).status).toBe(503);
 vi.stubEnv('DIALPAD_VOICE_WEBHOOK_PREVIOUS_SOURCE_IDS','a,b,c,d');expect((await POST(signedRequest())).status).toBe(503);expect(persistDialpadVoiceReceipt).not.toHaveBeenCalled();
});
