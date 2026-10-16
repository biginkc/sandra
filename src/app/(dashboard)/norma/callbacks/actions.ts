"use server";
import { createClient } from "@/lib/supabase/server";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export async function findCallbackLeads(callId: string, query: string) {
  const client = await createClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user || !uuid.test(callId)) return { error: "Not authorized", leads: [] };
  const text=typeof query==="string"?query.trim():"";
  if (text.length<3 || text.length>100) return { error: "Enter at least three characters of the address", leads: [] };
  const {data:call,error:callError}=await client.from("norma_inbound_calls").select("org_id").eq("id",callId).maybeSingle();
  if(callError || !call) return {error:"Call not found",leads:[]};
  const {data,error:searchError}=await client.from("properties").select("id,address").eq("org_id",call.org_id).is("deleted_at",null).ilike("address",`%${text.replace(/[\\%_]/g,"\\$&")}%`).order("address").limit(20);
  return searchError?{error:"Unable to search leads",leads:[]}:{leads:data??[]};
}
export async function associateCallback(callId: string,propertyId: string,updatedAt: string) {
  if(!uuid.test(callId)||!uuid.test(propertyId)||typeof updatedAt!=="string"||updatedAt.length>64||!Number.isFinite(Date.parse(updatedAt))) return {error:"Invalid selection"};
  const client=await createClient();
  const {data:{user},error:authError}=await client.auth.getUser();
  if(authError||!user) return {error:"Not signed in"};
  const {error}=await client.rpc("fn_norma_associate_inbound_call",{p_call_id:callId,p_property_id:propertyId,p_expected_updated_at:updatedAt});
  if(error) return {error:error.code==="40001"?"This call changed. Reload before reviewing it.":"Unable to associate this call. Check your access and try again."};
  return {ok:true};
}
