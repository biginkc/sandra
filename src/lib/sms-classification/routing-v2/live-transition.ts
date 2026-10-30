import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import type { V2Action } from "./actions";
import { readRoutingV2Flags } from "./flags";
import { compileV2Transition } from "./transition-plan";

type Evidence = { status:string; org_id:string; property_id:string; road:string; action:V2Action|null };
type Loose = {
  from:(table:string)=>{select:(columns:string)=>{eq:(key:string,value:string)=>{maybeSingle:()=>PromiseLike<{data:Evidence|null;error:unknown}>}}};
  rpc:(name:string,args:Record<string,unknown>)=>PromiseLike<{data:Record<string,unknown>|null;error:unknown}>;
};
export type V2LiveTransitionResult =
  | { kind:"applied"; transition:Record<string,unknown> }
  /** alertsQueued: owner-alert intents still queued for a stale / no-drip decision (B1/B2). */
  | { kind:"refused"; reason:string; alertsQueued?: number };

/** Both first attempt and recovery compile the ORIGINAL immutable action. A duplicate
 * classifier run never supplies replacement effects. The RPC rechecks identity/revision
 * under the property lock, and the existing outbox still owns delivery authorization.
 */
export async function applyStoredV2Transition(
  db:SupabaseClient<Database>,
  input:{orgId:string;propertyId:string;contactId:string;inboundMessageId:string},
):Promise<V2LiveTransitionResult> {
  const client=db as unknown as Loose;
  try {
    const {data:evidence,error}=await client.from("routing_v2_live_decisions")
      .select("status,org_id,property_id,road,action").eq("inbound_message_id",input.inboundMessageId).maybeSingle();
    if(error || !evidence || evidence.status!=="decided" || !evidence.action) return {kind:"refused",reason:"evidence_missing"};
    if(evidence.org_id!==input.orgId || evidence.property_id!==input.propertyId || evidence.road!==evidence.action.road) {
      return {kind:"refused",reason:"evidence_mismatch"};
    }
    if(evidence.action.steps.some(step=>step.kind==="hold" || step.kind==="wrong_number_close")) {
      return {kind:"refused",reason:"specialized_action_required"};
    }
    const flags=await readRoutingV2Flags(db,input.orgId);
    let plan:ReturnType<typeof compileV2Transition>;
    try { plan=compileV2Transition(evidence.action,{...input,flags}); }
    catch(error) {
      // N1: an effect the current flags cannot carry (e.g. an alert with replies off) is never
      // dropped silently; the caller holds for a person.
      return {kind:"refused",reason:error instanceof Error && error.message.startsWith("routing_v2_") ? error.message : "plan_failed"};
    }
    const {data,error:rpcError}=await client.rpc("routing_v2_apply_live_transition",{
      p_inbound_message_id:input.inboundMessageId,p_property_id:input.propertyId,p_decision:plan,
    });
    if(rpcError || !data || typeof data.outcome!=="string") return {kind:"refused",reason:"transition_failed"};
    // no_sequence is never success: the caller must hold for a person (B2). Stale decisions
    // (superseded / context_changed / no_sequence) still queue the owner alerts in SQL (B1).
    if(!["applied","replies_only"].includes(data.outcome)) {
      return typeof data.alerts_queued==="number"
        ? {kind:"refused",reason:data.outcome,alertsQueued:data.alerts_queued}
        : {kind:"refused",reason:data.outcome};
    }
    return {kind:"applied",transition:data};
  } catch { return {kind:"refused",reason:"transition_failed"}; }
}
