import 'server-only';
import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { getAcquisitionRoster, myLeadsViewer } from '@/lib/my-leads/queries';
import { canViewCalculators } from './access';
import { hasActiveSandraAccess } from '@/lib/auth/access-state';
import type { Database } from '@/lib/supabase/types';
import type { CalculatorLead, CalculatorSnapshot, CalculatorPageCursor } from './types';
import { UUID } from './validation';

type CalculatorDatabase = Database & { public: Database['public'] & { Tables: Database['public']['Tables'] & {
  offer_calculations: { Row: CalculatorSnapshot; Insert: never; Update: never; Relationships: [] }
} } };
export const calculatorReader = cache(async () => {
  const viewer = await myLeadsViewer();
  const client = await createClient();
  const { data: member, error } = await client.from('memberships')
    .select('access_status, access_expires_at, deletion_prepared_at').eq('org_id', viewer.orgId).eq('user_id', viewer.userId).maybeSingle();
  if (error || !member || member.access_status !== 'active' || !hasActiveSandraAccess(member)) throw new Error('Your access is no longer active.');
  return { ...viewer, client };
});
export const calculatorViewer = cache(async () => {
  const viewer = await calculatorReader();
  const { roster } = await getAcquisitionRoster();
  if (!canViewCalculators(roster, viewer.userId, viewer.isOwner)) throw new Error('Calculators are available to the Acquisitions group.');
  return viewer;
});
const LEAD_COLUMNS = 'id,address,city,state,status,homeowner:contacts!properties_homeowner_contact_id_fkey(first_name,last_name)';
type LeadRow = { id: string; address: string; city: string|null; state: string|null; status: string; homeowner: {first_name:string|null;last_name:string|null}|null };
function presentLead(row: LeadRow): CalculatorLead {
  return { id: row.id, address: [row.address,row.city,row.state].filter(Boolean).join(', '),
    seller: [row.homeowner?.first_name,row.homeowner?.last_name].filter(Boolean).join(' ') || 'Seller name unavailable', status: row.status };
}
export const getCalculatorLead = cache(async (id: string): Promise<CalculatorLead> => {
  if (!UUID.test(id)) throw new Error('Lead not found.');
  const v = await calculatorViewer();
  const {data,error}=await v.client.from('properties').select(LEAD_COLUMNS)
    .eq('id',id).eq('org_id',v.orgId).is('deleted_at',null).maybeSingle();
  if(error || !data) throw new Error('Lead unavailable or access denied.');
  return presentLead(data as unknown as LeadRow);
});
export const getReadableCalculatorLead = cache(async (id:string):Promise<CalculatorLead> => {
  if(!UUID.test(id)) throw new Error('Lead not found.');
  const v=await calculatorReader();
  const {data,error}=await v.client.from('properties').select(LEAD_COLUMNS).eq('id',id).eq('org_id',v.orgId).is('deleted_at',null).maybeSingle();
  if(error||!data) throw new Error('Lead unavailable or access denied.');
  return presentLead(data as unknown as LeadRow);
});
export async function searchLeads(query: string): Promise<CalculatorLead[]> {
  const v = await calculatorViewer();
  const term=query.trim().slice(0,100);
  if(term.length<3) return [];

  // Reuse the global search ranking and matching rules. Property hits support
  // address search; property-backed owner hits preserve seller-name search.
  const {data:hits,error:searchError}=await v.client.rpc('search_global',{q:term,per_type:5});
  if(searchError) throw new Error('Lead search failed. Please retry.');
  const propertyIds=[...new Set((hits??[]).flatMap(hit=>
    hit.entity_type==='property'?[hit.entity_id]
      :hit.entity_type==='owner'&&hit.property_id?[hit.property_id]:[],
  ))];
  if(propertyIds.length===0) return [];

  const {data,error}=await v.client.from('properties').select(LEAD_COLUMNS)
    .eq('org_id',v.orgId).is('deleted_at',null).in('id',propertyIds);
  if(error) throw new Error('Lead search failed. Please retry.');
  const byId=new Map((data??[]).map(row=>[row.id,presentLead(row as unknown as LeadRow)]));
  return propertyIds.flatMap(id=>{const lead=byId.get(id);return lead?[lead]:[];});
}
export async function getCalculation(id:string): Promise<CalculatorSnapshot> {
  if(!UUID.test(id)) throw new Error('Calculation not found.');
  const v=await calculatorReader();
  const {data,error}=await (v.client as unknown as SupabaseClient<CalculatorDatabase>).from('offer_calculations').select('*').eq('id',id).eq('org_id',v.orgId).maybeSingle();
  if(error||!data) throw new Error('Calculation unavailable or access denied.');
  await getReadableCalculatorLead(data.property_id);
  return data as CalculatorSnapshot;
}
export async function listCalculations(leadId:string,cursor:CalculatorPageCursor|null=null): Promise<CalculatorSnapshot[]> {
  await getReadableCalculatorLead(leadId);
  const v=await calculatorReader();
  let query=(v.client as unknown as SupabaseClient<CalculatorDatabase>).from('offer_calculations').select('*').eq('org_id',v.orgId).eq('property_id',leadId);
  if(cursor) query=query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  const {data,error}=await query.order('created_at',{ascending:false}).order('id',{ascending:false}).limit(20);
  if(error) throw new Error('Saved calculations could not load. Please retry.');
  return (data??[]) as CalculatorSnapshot[];
}
