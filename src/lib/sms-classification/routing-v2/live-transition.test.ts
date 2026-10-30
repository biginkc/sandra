import { describe,expect,it,vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { ALL_OFF } from "./flags";
import { applyStoredV2Transition } from "./live-transition";
vi.mock("./flags",async(importOriginal)=>({...await importOriginal<typeof import("./flags")>(),readRoutingV2Flags:vi.fn(async()=>({...ALL_OFF,questions_live:true,replies:true,drips:true,canaryPercent:100}))}));
const input={orgId:"org",propertyId:"11111111-1111-4111-8111-111111111111",contactId:"contact",inboundMessageId:"inbound"};
const evidence={status:"decided",org_id:"org",property_id:input.propertyId,road:"who_reply_drip",action:{road:"who_reply_drip",steps:[{kind:"reply",key:"identity"},{kind:"drip",drip:"Asked who is texting",skipFirstStep:true}]}};
function fixture(data:unknown=evidence,result:unknown={outcome:"applied",replayed:false}) {
  const rpc=vi.fn(async()=>({data:result,error:null}));
  const maybeSingle=vi.fn(async()=>({data,error:null}));
  const db={from:vi.fn(()=>({select:()=>({eq:()=>({maybeSingle})})})),rpc} as unknown as SupabaseClient<Database>;
  return {db,rpc};
}
describe("durable live action adapter",()=>{
  it("compiles the stored action and sends exactly one guarded transaction",async()=>{
    const {db,rpc}=fixture();expect(await applyStoredV2Transition(db,input)).toMatchObject({kind:"applied"});
    expect(rpc).toHaveBeenCalledExactlyOnceWith("routing_v2_apply_live_transition",{p_inbound_message_id:"inbound",p_property_id:input.propertyId,p_decision:expect.objectContaining({sequence_key:"asked_who",skip_first_step:true,outbox:[expect.objectContaining({kind:"reply"})]})});
  });
  it.each([null,{...evidence,status:"failed"},{...evidence,action:null}])("does not execute missing/failed evidence",async(row)=>{
    const {db,rpc}=fixture(row);expect(await applyStoredV2Transition(db,input)).toEqual({kind:"refused",reason:"evidence_missing"});expect(rpc).not.toHaveBeenCalled();
  });
  it("rejects evidence from another org",async()=>{
    const {db,rpc}=fixture({...evidence,org_id:"other"});expect(await applyStoredV2Transition(db,input)).toEqual({kind:"refused",reason:"evidence_mismatch"});expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["hold","wrong_number_close"])("requires the specialized %s adapter",async(kind)=>{
    const {db,rpc}=fixture({...evidence,action:{road:evidence.road,steps:[{kind}]}});expect(await applyStoredV2Transition(db,input)).toEqual({kind:"refused",reason:"specialized_action_required"});expect(rpc).not.toHaveBeenCalled();
  });
  it.each(["context_changed","superseded","flag_off"])("retains RPC refusal %s",async(outcome)=>{
    const {db}=fixture(evidence,{outcome});expect(await applyStoredV2Transition(db,input)).toEqual({kind:"refused",reason:outcome});
  });
  it("treats no_sequence as a refusal so the caller holds for a person (B2)",async()=>{
    const {db}=fixture(evidence,{outcome:"no_sequence",alerts_queued:0});
    expect(await applyStoredV2Transition(db,input)).toEqual({kind:"refused",reason:"no_sequence",alertsQueued:0});
  });
  it("reports owner alerts still queued for a stale decision (B1)",async()=>{
    const {db}=fixture(evidence,{outcome:"superseded",alerts_queued:1});
    expect(await applyStoredV2Transition(db,input)).toEqual({kind:"refused",reason:"superseded",alertsQueued:1});
  });
  it("never calls a malformed result applied",async()=>{
    const {db}=fixture(evidence,{});expect(await applyStoredV2Transition(db,input)).toEqual({kind:"refused",reason:"transition_failed"});
  });
});
