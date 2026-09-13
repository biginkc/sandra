'use server';
import { revalidatePath } from 'next/cache';
import type { Json } from '@/lib/supabase/types';
import { getAcquisitionQueue,getAcquisitionKpis,getAcquisitionDetail,myLeadsViewer,type DetailGroup } from '@/lib/my-leads/queries';
import { setAcquisitionDesignation,setAcquisitionSettings } from '@/lib/my-leads/settings';
import type { SetAcquisitionDesignationInput,SetAcquisitionSettingsInput } from '@/lib/my-leads/types';
import type { QueueStage } from '@/lib/my-leads/types';

export async function loadMyLeads(input:{memberId:string;search:string;period:'today'|'week'|'month'|'custom';startDate?:string;endDate?:string}) {
  try {
    const [snapshot,kpis]=await Promise.all([getAcquisitionQueue(input),getAcquisitionKpis(input)]);
    return {ok:true as const,snapshot,kpis};
  } catch(error) {return {ok:false as const,message:error instanceof Error?error.message:'Could not load My Leads.'};}
}
export async function loadMyLeadsStage(input:{memberId:string;search:string;stage:QueueStage;cursor:string}) {
  try {return {ok:true as const,snapshot:await getAcquisitionQueue(input)};}
  catch(error){return {ok:false as const,message:error instanceof Error?error.message:'Could not load this section.'};}
}
export async function loadMyLeadDetail(input:{memberId:string;propertyId:string;group?:DetailGroup;cursor?:string|null}) {
  try {return {ok:true as const,detail:await getAcquisitionDetail(input)};}
  catch(error){return {ok:false as const,message:error instanceof Error?error.message:'Could not load lead details.'};}
}
const commands={
  'log-attempt':'fn_log_acquisition_attempt','ready-for-offer':'fn_ready_acquisition_offer','log-offer':'fn_log_acquisition_offer',
  'contract-signed':'fn_record_acquisition_contract','decline-offer':'fn_decline_acquisition_offer','handoff':'fn_handoff_acquisition_lead','archive':'fn_archive_acquisition_contract',
} as const;
export async function submitMyLeadCommand(command:keyof typeof commands,input:Record<string,Json>) {
  if(!Object.hasOwn(commands,command)) return {ok:false as const,message:'Unsupported action.'};
  let viewer;
  try { viewer=await myLeadsViewer(); }
  catch { return {ok:false as const,message:'Sign in with an active organization before updating a lead.'}; }
  const client=viewer.client;
  input={...input,orgId:viewer.orgId};
  const {data,error}=await (client as unknown as {rpc(name:string,args:{p_input:Json}):Promise<{data:Json|null;error:{message?:string}|null}>}).rpc(command==='log-attempt'&&input.source==='sandra'?'fn_finalize_acquisition_attempt':commands[command],{p_input:input});
  if(error) {
    const message=error.message??'';
    return {ok:false as const,message:message.includes('STALE_')?'This lead changed. Refresh before trying again.':message.includes('MOTIVATION')?'Specify motivation or choose No motivation provided.':message.includes('PENDING_OFFER')?'Resolve the current pending offer first.':message.includes('RECIPIENT')?'The handoff recipient is unavailable. Ask the owner to update settings.':'The update could not be saved. Check the fields and retry.'};
  }
  if(!data||typeof data!=='object'||Array.isArray(data)||data.ok!==true) return {ok:false as const,message:'The update was not confirmed. Retry with the same form.'};
  revalidatePath('/my-leads');revalidatePath('/leads');
  if(typeof input.propertyId==='string') revalidatePath(`/leads/${input.propertyId}`);
  return {ok:true as const};
}
export async function changeAcquisitionDesignation(input:SetAcquisitionDesignationInput) {
  const result=await setAcquisitionDesignation(input);if(result.ok) revalidatePath('/my-leads');return result;
}
export async function changeAcquisitionSettings(input:SetAcquisitionSettingsInput) {
  const result=await setAcquisitionSettings(input);if(result.ok) revalidatePath('/my-leads');return result;
}

export async function loadMyLeadCallReferences(propertyId:string,memberId:string) {
  try {
    const viewer=await myLeadsViewer();
    const {data,error}=await (viewer.client as unknown as {rpc(name:string,args:Record<string,string>):Promise<{data:{id:string;occurredAt:string}[]|null;error:unknown}>}).rpc('fn_get_acquisition_call_references',{p_org_id:viewer.orgId,p_property_id:propertyId,p_member_id:memberId});
    if(error||!data)return {ok:false as const,message:'Could not load pending call references.'};
    return {ok:true as const,options:data.map(call=>({id:call.id,label:new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Chicago'}).format(new Date(call.occurredAt))+' Central'}))};
  }catch{return {ok:false as const,message:'Could not load pending call references.'};}
}
