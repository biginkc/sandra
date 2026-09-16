'use server';
import { createHash } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { createAdminClient } from '@/lib/supabase/admin';
import { calculatorViewer, getCalculatorLead, listCalculations, searchLeads } from '@/lib/calculators/server';
import { calculateClosr, FORMULA_VERSION, WORKSHEET_SHA256 } from '@/lib/calculators/closr-v1';
import { validateCalculation, UUID } from '@/lib/calculators/validation';
import type { CalculatorPageCursor, CalculatorActionResult, CalculatorLead, CalculatorSnapshot, SaveCalculationInput } from '@/lib/calculators/types';
import type { Json } from '@/lib/supabase/types';

export async function searchCalculatorLeads(query:string): Promise<CalculatorActionResult<CalculatorLead[]>> {
  try { if(typeof query!=='string') throw new Error('Enter an address or seller name.'); return {ok:true,data:await searchLeads(query)}; }
  catch { return {ok:false,error:'Lead search unavailable. Check your access and retry.'}; }
}
export async function loadLeadCalculations(leadId:string,cursor:CalculatorPageCursor|null=null): Promise<CalculatorActionResult<CalculatorSnapshot[]>> {
  try { if(cursor && (!UUID.test(cursor.id)||typeof cursor.createdAt!=='string'||!/^\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.createdAt)||!Number.isFinite(Date.parse(cursor.createdAt)))) throw new Error('Invalid page.'); return {ok:true,data:await listCalculations(leadId,cursor)}; }
  catch { return {ok:false,error:'Saved calculations could not load. Check your access and retry.'}; }
}
export async function saveCalculation(raw:SaveCalculationInput): Promise<CalculatorActionResult<CalculatorSnapshot>> {
  let input:SaveCalculationInput;
  try { input=validateCalculation(raw); }
  catch(error) { return {ok:false,error:error instanceof Error?error.message:'Check the inputs.'}; }
  try {
    const v=await calculatorViewer();
    await getCalculatorLead(input.leadId);
    const results=calculateClosr(input.inputs);
    const requestHash=createHash('sha256').update(JSON.stringify({ ...input, results, formulaVersion:FORMULA_VERSION, worksheet:WORKSHEET_SHA256 })).digest('hex');
    const admin=createAdminClient() as unknown as {rpc(name:string,args:Record<string,Json>):Promise<{data:unknown;error:{message:string}|null}>};
    const {data,error}=await admin.rpc('fn_save_offer_calculation',{
      p_actor_id:v.userId,p_property_id:input.leadId,p_inputs:input.inputs,p_results:results as unknown as Json,
      p_decision:input.decision,p_provenance:input.provenance,p_formula_version:FORMULA_VERSION,
      p_request_id:input.requestId,p_request_hash:requestHash,p_parent_id:input.parentId,
    });
    if(error||!data) return {ok:false,error:error?.message.includes('IDEMPOTENCY_CONFLICT')?'This save request changed. Make an edit and save again.':'Calculation was not confirmed saved. Your inputs are intact; retry or check lead access.'};
    const snapshot=data as CalculatorSnapshot;
    // The committed receipt is success even if a subsequent cache invalidation fails.
    try { revalidatePath(`/leads/${snapshot.property_id}`); revalidatePath('/calculators'); } catch { /* Read on next navigation. */ }
    return {ok:true,data:snapshot};
  } catch { return {ok:false,error:'Calculation was not confirmed saved. Your inputs are intact; retry or check lead access.'}; }
}
