import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
type RpcClient={rpc(name:string,args:Record<string,string|boolean|null>):PromiseLike<{error:{code?:string}|null}>};
export async function reserveJitterTransport(orgId:string,actorId:string,token:string,propertyId:string|null) {
  const result=await (createAdminClient() as unknown as RpcClient).rpc("fn_reserve_jitter_transport",{p_org_id:orgId,p_actor_id:actorId,p_token:token,p_property_id:propertyId});
  if(result.error) {
    // Legacy deployments without the pilot migration stay functional only when
    // no voice pilot is configured. Once configured, absence fails closed.
    if(result.error.code==="PGRST202" && !process.env.DIALPAD_VOICE_ORG_ID && process.env.DIALPAD_VOICE_START_ENABLED!=="true") return false;
    throw new Error("Another voice call is active or its status is unconfirmed.");
  }
  return true;
}
export async function finishJitterTransport(orgId:string,actorId:string,token:string,callId:string|null,noDispatch:boolean) {
  const result=await (createAdminClient() as unknown as RpcClient).rpc("fn_finish_jitter_transport",{p_org_id:orgId,p_actor_id:actorId,p_token:token,p_call_id:callId,p_no_dispatch:noDispatch});
  if(result.error) throw new Error("Voice reservation update unconfirmed");
}

export async function markJitterDispatch(orgId:string,actorId:string,token:string) {
  const result=await (createAdminClient() as unknown as RpcClient).rpc("fn_mark_jitter_dispatch",{p_org_id:orgId,p_actor_id:actorId,p_token:token});
  if(result.error) throw new Error("Voice reservation dispatch unconfirmed");
}
