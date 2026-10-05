import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { parseInboundCall } from "./inbound";
async function readProviderJson(response:Response):Promise<unknown> {
  if(!response.body)return null;
  const reader=response.body.getReader(); const decoder=new TextDecoder(); let bytes=0;let text="";
  try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>4*1024*1024){await reader.cancel();return null;}text+=decoder.decode(value,{stream:true});}return JSON.parse(text+decoder.decode());}
  finally{reader.releaseLock();}
}

export async function reconcileInboundRecordings(client: SupabaseClient<Database>, apiKey: string, fetcher: typeof fetch = fetch) {
  const {data:claims,error}=await client.rpc("fn_norma_claim_inbound_recordings",{});
  if(error)throw new Error("Inbound recording claim failed");
  const result={checked:0,updated:0,denied:0,unavailable:0};
  for(const call of claims??[]) {
    result.checked++;
    let state: "pending"|"done"|"denied"|"unavailable"=call.reconciliation_attempts>=6?"unavailable":"pending";
    try {
      const response=await fetcher(`https://api.bland.ai/v1/calls/${encodeURIComponent(call.provider_call_id)}`,{headers:{authorization:`Bearer ${apiKey}`},redirect:"error",cache:"no-store",signal:AbortSignal.timeout(8_000)});
      if(response.status===401||response.status===403){
        state="denied";result.denied++;await response.body?.cancel();
        const paused=await client.rpc("fn_norma_pause_inbound_lookups",{});
        if(paused.error)throw new Error("Inbound lookup pause failed");
      }
      else if(response.ok) {
        // Bound decoded provider JSON without logging response contents or media URLs.
        const parsed=parseInboundCall(await readProviderJson(response));
        if(parsed && parsed.callId===call.provider_call_id && parsed.from===call.from_e164 && parsed.to===call.to_e164) {
          const saved=await client.rpc("fn_norma_ingest_inbound_call",{p_call_id:parsed.callId,p_from:parsed.from,p_to:parsed.to,p_completed:parsed.completed,p_recording_state:parsed.recordingState});
          if(saved.error || !saved.data)throw new Error("Inbound recording update failed");
          if(parsed.recordingState!=="pending"){state="done";result.updated++;}
        }
      } else {await response.body?.cancel();}
    } catch {
      if(state==="denied")throw new Error("Inbound lookup denial could not be checkpointed");
      // Transient lookup failures remain bounded by persisted attempts/backoff.
    }
    // A later webhook wins: do not replace its completed recording evidence with stale lookup state.
    const saved=await client.from("norma_inbound_calls").update({reconciliation_state:state==="denied"?"pending":state}).eq("id",call.id).eq("reconciliation_attempts",call.reconciliation_attempts).eq("recording_state","pending");
    if(saved.error)throw new Error("Inbound recording checkpoint failed");
    if(state==="unavailable")result.unavailable++;
    // Stop the whole run on denial; do not probe the same credential through other call IDs.
    if(state==="denied")break;
  }
  return result;
}
