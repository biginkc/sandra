import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import {describe,expect,it,vi} from "vitest";
import {reconcileInboundRecordings} from "./inbound-reconcile";
function fixture(attempts=1,count=1){
 const claims=Array.from({length:count},(_,i)=>({id:`row-${i}`,provider_call_id:`call-${i}`,from_e164:"+18165551001",to_e164:"+18165551002",reconciliation_attempts:attempts,lease_id:"lease"}));
 const rpc=vi.fn(async(name:string):Promise<{data:unknown;error:unknown}>=>name==="fn_norma_claim_inbound_recordings"?{data:claims,error:null}:{data:true,error:null});
 const client={rpc} as unknown as SupabaseClient<Database>;
 const fetcher=vi.fn<typeof fetch>();
 return{client,rpc,fetcher};
}
const found={inbound:true,call_id:"call-0",from:"+18165551001",to:"+18165551002",completed:true,recording_url:"https://private.invalid"};
const checkpoint=(state:string)=>["fn_norma_checkpoint_inbound_lookup",expect.objectContaining({p_state:state,p_call_id:"row-0",p_lease_id:"lease"})];
describe("bounded inbound recording reconciliation",()=>{
 it("stores minimal late evidence through a leased checkpoint",async()=>{
  const f=fixture();f.fetcher.mockResolvedValue(Response.json(found));
  expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({updated:1,checked:1});
  expect(f.rpc).toHaveBeenCalledWith("fn_norma_ingest_inbound_call",{p_call_id:"call-0",p_from:found.from,p_to:found.to,p_completed:true,p_recording_state:"reported_available"});
  expect(f.rpc).toHaveBeenCalledWith(...checkpoint("done"));
  expect(JSON.stringify(f.rpc.mock.calls)).not.toContain("private.invalid");
 });
 it.each([401,403])("persists denial and stops the entire batch on %s",async(status)=>{
  const f=fixture(1,3);f.fetcher.mockResolvedValue(new Response("private denial",{status}));
  expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({checked:1,denied:1});
  expect(f.fetcher).toHaveBeenCalledOnce();expect(f.rpc).toHaveBeenCalledWith("fn_norma_finish_inbound_lookup",{p_lease_id:"lease",p_denied:true});
  expect(f.rpc.mock.calls.some(([n])=>n==="fn_norma_checkpoint_inbound_lookup")).toBe(false);
 });
 it("persists denial even when body cancellation throws",async()=>{
  const f=fixture(1,3);f.fetcher.mockResolvedValue({status:403,body:{cancel:async()=>{throw new Error("cancel");}}} as unknown as Response);
  expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({denied:1});
  expect(f.fetcher).toHaveBeenCalledOnce();expect(f.rpc).toHaveBeenCalledWith("fn_norma_finish_inbound_lookup",{p_lease_id:"lease",p_denied:true});
 });
 it("does not clear the admission barrier if denial persistence fails",async()=>{
  const f=fixture(1,3);const prior=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async(n)=>n==="fn_norma_finish_inbound_lookup"?{data:null,error:{message:"offline"}}:prior(n));
  f.fetcher.mockResolvedValue(new Response(null,{status:403}));
  await expect(reconcileInboundRecordings(f.client,"test-key",f.fetcher)).rejects.toThrow("release failed");
  expect(f.rpc).toHaveBeenCalledWith("fn_norma_start_inbound_lookup",{p_lease_id:"lease",p_call_id:"row-0"});
  expect(f.fetcher).toHaveBeenCalledOnce();expect(f.rpc.mock.calls.some(([n])=>n==="fn_norma_checkpoint_inbound_lookup")).toBe(false);
 });
 it("does not contact the provider when per-request admission is denied",async()=>{
  const f=fixture(1,3);const prior=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async(n)=>n==="fn_norma_start_inbound_lookup"?{data:false,error:null}:prior(n));
  expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({checked:0});expect(f.fetcher).not.toHaveBeenCalled();
 });
 it("stops on a failed checkpoint without admitting the next request",async()=>{
  const f=fixture(1,3);const prior=f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async(n)=>n==="fn_norma_checkpoint_inbound_lookup"?{data:null,error:{message:"offline"}}:prior(n));
  f.fetcher.mockResolvedValue(new Response(null,{status:404}));
  await expect(reconcileInboundRecordings(f.client,"test-key",f.fetcher)).rejects.toThrow("checkpoint failed");expect(f.fetcher).toHaveBeenCalledOnce();
 });
 it("does not mark evidence saved when the destination was disabled after claim",async()=>{
  const f=fixture();const prior=f.rpc.getMockImplementation()!;f.rpc.mockImplementation(async(name)=>name==="fn_norma_ingest_inbound_call"?{data:null,error:null}:prior(name));
  f.fetcher.mockResolvedValue(Response.json(found));expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({updated:0});expect(f.rpc).toHaveBeenCalledWith(...checkpoint("pending"));
 });
 it("keeps transient failures pending within the attempt budget",async()=>{
  const f=fixture();f.fetcher.mockRejectedValue(new Error("timeout"));await reconcileInboundRecordings(f.client,"test-key",f.fetcher);
  expect(f.rpc).toHaveBeenCalledWith(...checkpoint("pending"));
 });
 it("ends unsuccessful lookup after six attempts",async()=>{
  const f=fixture(6);f.fetcher.mockResolvedValue(new Response(null,{status:404}));await reconcileInboundRecordings(f.client,"test-key",f.fetcher);
  expect(f.rpc).toHaveBeenCalledWith(...checkpoint("unavailable"));
 });
 it("does not ingest changed call identity or direction",async()=>{
  for(const delta of [{call_id:"wrong"},{from:"+18165551999"},{to:"+18165551999"},{inbound:false}]){
   const f=fixture();f.fetcher.mockResolvedValue(Response.json({...found,...delta}));await reconcileInboundRecordings(f.client,"test-key",f.fetcher);
   expect(f.rpc.mock.calls.some(([name])=>name==="fn_norma_ingest_inbound_call")).toBe(false);
  }
 });
 it("rejects oversized provider JSON without attempting ingestion",async()=>{
  const f=fixture();f.fetcher.mockResolvedValue(new Response("x".repeat(4*1024*1024+1)));await reconcileInboundRecordings(f.client,"test-key",f.fetcher);
  expect(f.rpc.mock.calls.some(([name])=>name==="fn_norma_ingest_inbound_call")).toBe(false);
 });
});
