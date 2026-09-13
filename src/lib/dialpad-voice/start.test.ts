import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const m = vi.hoisted(() => ({ rpc: vi.fn(), roster: vi.fn(), prepare: vi.fn(), bind: vi.fn(), from: vi.fn(), devices: vi.fn(), callers: vi.fn(), initiate: vi.fn() }));
vi.mock("@/lib/my-leads/queries", () => ({ getAcquisitionRoster: m.roster }));
vi.mock("@/lib/dialer/actions", () => ({ inspectLeadCall: m.prepare }));
vi.mock("@/lib/my-leads/call-binding", () => ({ bindAcquisitionCallContext: m.bind }));
vi.mock("./database", () => ({ createDialpadVoiceAdminClient: () => ({ from: m.from, rpc: m.rpc }) }));
vi.mock("./client", async importOriginal => { const actual = await importOriginal<typeof import("./client")>(); return { ...actual, DialpadVoiceClient: class { listUserDevices = m.devices; getCallerId = m.callers; initiateSelectedDeviceCall = m.initiate; } }; });
import { DialpadVoiceError } from "./client";
import { startMariaDialpadCall } from "./start";
const org = "11111111-1111-4111-8111-111111111111", actor = "22222222-2222-4222-8222-222222222222", propertyId = "33333333-3333-4333-8333-333333333333", key = "44444444-4444-4444-8444-444444444444";
const input = { propertyId, idempotencyKey: key };
let replies: unknown[];
function query() { const q: Record<string, unknown> = {}; for (const name of ["select","eq","insert","update"]) q[name] = vi.fn(() => q); q.maybeSingle = q.single = vi.fn(async () => replies.shift()); return q; }
beforeEach(() => {
  vi.resetAllMocks();
  for (const [name,value] of Object.entries({ DIALPAD_VOICE_START_ENABLED:"true", DIALPAD_VOICE_ORG_ID:org, DIALPAD_VOICE_SANDRA_USER_ID:actor, DIALPAD_VOICE_USER_ID:"4904023124647936", DIALPAD_VOICE_CALLER_ID:"+18163706846", DIALPAD_VOICE_DEVICE_ID:"web-device", DIALPAD_VOICE_API_KEY:"private" })) vi.stubEnv(name,value);
  m.roster.mockResolvedValue({ viewer:{orgId:org,userId:actor},roster:{settings:{enabled:true},members:[{id:actor,active:true,acquisitionsEnabled:true}]} });
  m.devices.mockResolvedValue({items:[{id:"web-device",type:"web",user_id:"4904023124647936"}]}); m.callers.mockResolvedValue({phone_numbers:["+18163706846"]});
  m.prepare.mockResolvedValue({ok:true,data:{propertyId,phoneE164:"+15555550101"}});m.bind.mockResolvedValue({tracked:true,assignmentEpisodeId:null});
  m.rpc.mockImplementation(async (name:string)=>({data:name==="fn_prepare_dialpad_sequence_pause"?{paused:1}:name==="fn_dispatch_dialpad_intent"?{dispatched:true}:{released:true,resumed:1},error:null}));
  replies=[{data:null,error:null},{data:{id:key,status:"prepared"},error:null},{data:{id:key},error:null}];m.from.mockImplementation(query);
});
afterEach(() => vi.unstubAllEnvs());
describe("Maria guarded start", () => {
  it("does no auth, preparation or provider work when disabled",async()=>{ vi.stubEnv("DIALPAD_VOICE_START_ENABLED","false");expect(await startMariaDialpadCall(input)).toEqual({ok:false,error:"dialpad_start_disabled"});expect(m.roster).not.toHaveBeenCalled();expect(m.prepare).not.toHaveBeenCalled(); });
  it("rejects another actor before any side effect",async()=>{m.roster.mockResolvedValue({viewer:{orgId:org,userId:key},roster:{settings:{enabled:true},members:[]}});expect(await startMariaDialpadCall(input)).toMatchObject({ok:false,error:"forbidden"});expect(m.from).not.toHaveBeenCalled();});
  it("returns a prior intent without retrying and conflicts on changed property",async()=>{replies=[{data:{id:key,property_id:propertyId,status:"initiation_unconfirmed"},error:null}];expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,intentId:key});expect(m.prepare).not.toHaveBeenCalled();expect(m.initiate).not.toHaveBeenCalled();replies=[{data:{id:key,property_id:key,status:"prepared"},error:null}];expect(await startMariaDialpadCall(input)).toMatchObject({ok:false,error:"idempotency_conflict"});});
  it("requires Maria's selected web device before pausing a lead",async()=>{m.devices.mockResolvedValue({items:[{id:"web-device",type:"native",user_id:"4904023124647936"}]});expect(await startMariaDialpadCall(input)).toMatchObject({ok:false,error:"device_or_caller_id_unavailable"});expect(m.prepare).not.toHaveBeenCalled();});
  it("reserves, pauses, revalidates then dispatches exactly once",async()=>{
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"initiation_unconfirmed"});
    expect(m.prepare).toHaveBeenCalledTimes(2);
    expect(m.rpc.mock.calls.map(call=>call[0])).toEqual(["fn_prepare_dialpad_sequence_pause","fn_dispatch_dialpad_intent"]);
    expect(m.initiate).toHaveBeenCalledTimes(1);
    expect(m.initiate.mock.calls[0][0].customData).toBe(m.bind.mock.calls[0][0].callToken);
  });
  it("different-key conflict never pauses another property's sequences",async()=>{
    replies=[{data:null,error:null},{data:null,error:{code:"23505"}},{data:null,error:null}];
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:false,error:"active_call_conflict"});
    expect(m.rpc).not.toHaveBeenCalled();expect(m.initiate).not.toHaveBeenCalled();
  });
  it("same-key insert loser returns winner without another pause or call",async()=>{
    replies=[{data:null,error:null},{data:null,error:{code:"23505"}},{data:{id:key,property_id:propertyId,status:"initiation_unconfirmed"},error:null}];
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,intentId:key});
    expect(m.rpc).not.toHaveBeenCalled();expect(m.initiate).not.toHaveBeenCalled();
  });
  it("changed eligibility releases only owned pauses before dispatch",async()=>{
    m.prepare.mockResolvedValueOnce({ok:true,data:{propertyId,phoneE164:"+15555550101"}}).mockResolvedValueOnce({ok:false});
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"failed"});
    expect(m.rpc).toHaveBeenLastCalledWith("fn_release_dialpad_start",{p_intent_id:expect.any(String)});
    expect(m.initiate).not.toHaveBeenCalled();
  });
  it("does not dispatch or release after an uncertain dispatch claim",async()=>{
    m.rpc.mockResolvedValueOnce({data:{paused:1},error:null}).mockResolvedValueOnce({data:null,error:{message:"lost response"}});
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"initiation_unconfirmed"});
    expect(m.initiate).not.toHaveBeenCalled();expect(m.rpc).toHaveBeenCalledTimes(2);
  });
  it("never retries or releases on provider timeout",async()=>{
    m.initiate.mockRejectedValue(new Error("private transport error"));
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"initiation_unconfirmed"});
    expect(m.initiate).toHaveBeenCalledTimes(1);expect(m.rpc).toHaveBeenCalledTimes(2);
  });
  it("releases through scoped RPC only for definitive rejection",async()=>{
    m.initiate.mockRejectedValue(new DialpadVoiceError("http",422));
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"failed"});
    expect(m.rpc).toHaveBeenLastCalledWith("fn_release_dialpad_start",{p_intent_id:expect.any(String),p_rejection_http_status:422});
  });
  it("uses scoped cleanup after an uncertain pause RPC failure before dispatch",async()=>{
    m.rpc.mockRejectedValueOnce(new Error("pause response lost"));
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"failed"});
    expect(m.rpc).toHaveBeenLastCalledWith("fn_release_dialpad_start",{p_intent_id:expect.any(String)});
    expect(m.initiate).not.toHaveBeenCalled();
  });
  it("keeps429 uncertain rather than releasing a possibly active call",async()=>{
    m.initiate.mockRejectedValue(new DialpadVoiceError("http",429));
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"initiation_unconfirmed"});
    expect(m.rpc).toHaveBeenCalledTimes(2);
  });
  it("does not claim cleanup succeeded when its response fails",async()=>{
    m.prepare.mockResolvedValueOnce({ok:true,data:{propertyId,phoneE164:"+15555550101"}}).mockResolvedValueOnce({ok:false});
    m.rpc.mockResolvedValueOnce({data:{paused:1},error:null}).mockRejectedValueOnce(new Error("cleanup unavailable"));
    expect(await startMariaDialpadCall(input)).toMatchObject({ok:true,status:"prepared"});
    expect(m.initiate).not.toHaveBeenCalled();
  });

});
