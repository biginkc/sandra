import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import {describe,expect,it,vi} from "vitest";
import {reconcileInboundRecordings} from "./inbound-reconcile";
function fixture(attempts=1,count=1){
 const claims=Array.from({length:count},(_,i)=>({id:`row-${i}`,provider_call_id:`call-${i}`,from_e164:"+18165551001",to_e164:"+18165551002",reconciliation_attempts:attempts}));
 const rpc=vi.fn(async(name:string):Promise<{data:unknown;error:null}>=>name==="fn_norma_claim_inbound_recordings"?{data:claims,error:null}:{data:"stored",error:null});
 const eq=vi.fn();const query={eq,then:(resolve:(value:unknown)=>void)=>Promise.resolve({error:null}).then(resolve)};eq.mockReturnValue(query);
 const update=vi.fn(()=>query);const client={rpc,from:vi.fn(()=>({update}))} as unknown as SupabaseClient<Database>;
 const fetcher=vi.fn<typeof fetch>();
 return{client,rpc,eq,update,fetcher};
}
const found={inbound:true,call_id:"call-0",from:"+18165551001",to:"+18165551002",completed:true,recording_url:"https://private.invalid"};
describe("bounded inbound recording reconciliation",()=>{
 it("stores minimal late recording evidence and preserves newer webhook state",async()=>{
  const f=fixture();f.fetcher.mockResolvedValue(Response.json(found));
  expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({updated:1,checked:1});
  expect(f.rpc).toHaveBeenCalledWith("fn_norma_ingest_inbound_call",{p_call_id:"call-0",p_from:found.from,p_to:found.to,p_completed:true,p_recording_state:"reported_available"});
  expect(f.eq).toHaveBeenCalledWith("recording_state","pending");
  expect(JSON.stringify(f.rpc.mock.calls)).not.toContain("private.invalid");
 });
 it("pauses automatic lookups and stops the batch on an access denial",async()=>{
  const f=fixture(1,3);f.fetcher.mockResolvedValue(new Response("private denial",{status:403}));
  expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({checked:1,denied:1});
  expect(f.fetcher).toHaveBeenCalledOnce();expect(f.rpc).toHaveBeenCalledWith("fn_norma_pause_inbound_lookups",{});
  expect(f.update).toHaveBeenCalledWith({reconciliation_state:"pending"});
 });
 it("does not mark evidence saved when the destination was disabled after claim",async()=>{
  const f=fixture();const prior=f.rpc.getMockImplementation()!;f.rpc.mockImplementation(async(name)=>name==="fn_norma_ingest_inbound_call"?{data:null,error:null}:prior(name));
  f.fetcher.mockResolvedValue(Response.json(found));expect(await reconcileInboundRecordings(f.client,"test-key",f.fetcher)).toMatchObject({updated:0});expect(f.update).toHaveBeenCalledWith({reconciliation_state:"pending"});
 });
 it("keeps transient failures pending within the attempt budget",async()=>{
  const f=fixture();f.fetcher.mockRejectedValue(new Error("timeout"));await reconcileInboundRecordings(f.client,"test-key",f.fetcher);
  expect(f.update).toHaveBeenCalledWith({reconciliation_state:"pending"});
 });
 it("ends unsuccessful lookup after six attempts",async()=>{
  const f=fixture(6);f.fetcher.mockResolvedValue(new Response(null,{status:404}));await reconcileInboundRecordings(f.client,"test-key",f.fetcher);
  expect(f.update).toHaveBeenCalledWith({reconciliation_state:"unavailable"});
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
