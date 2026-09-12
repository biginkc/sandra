import 'server-only';
import { createClient } from '@/lib/supabase/server';
import { getCallerMemberships } from '@/lib/auth/memberships';
import type { Json } from '@/lib/supabase/types';
import type { QueueStage } from './types';
import { acquisitionDateRange, acquisitionPeriodBounds, type AcquisitionPeriod } from './period';

export type QueueRow = {
  propertyId: string; stage: QueueStage; queueVersion: number; sharedStatus: string;
  assignmentEpisodeId: string; assignedAt: string | null; initializedAt: string; episodeKind: 'live' | 'launch';
  clockEligible: boolean; firstCallAt: string | null; stageEnteredAt: string | null;
  address: string; city: string | null; state: string | null; homeownerName: string | null; phone: string | null; contactId: string | null; phones: string[]; contactDnc: boolean;
  temperature: 'hot' | 'warm' | 'cold' | null; motivationKind: 'specified' | 'no_motivation' | null; motivationText: string | null;
  warningReasons: string[]; nextStepAt: string | null; nextStepType: 'appointment' | 'callback' | null;
  offer: { id: string; amountCents: number; method: string; sentAt: string; followUpAt: string; outcome: 'pending'|'accepted'|'declined' } | null;
  attemptsCount: number;
};
export type QueuePage = { rows: QueueRow[]; totalCount: number; filteredCount: number; cursor: string | null; hasMore: boolean };
export type QueueSnapshot = { stages: Partial<Record<QueueStage, QueuePage>>; snapshotAt: string; nextWarningAt: string | null; search: string };
export type AcquisitionKpis = {
  attempts: number; reached: number; pendingOutcomes: number; firstCallSamples: number; firstCallPending: number;
  firstCallElapsedSeconds: number | null; appointmentsDue: number; appointmentsHeld: number;
  orgAppointmentsUnattributed: number; offersSent: number; staleLeads: number;
};
export type AcquisitionRecipient = { id: string; label: string };
export type AcquisitionRoster = {
  isOwner: boolean;
  members: { id: string; label: string; role: string; acquisitionsEnabled: boolean; active: boolean; hasHistory: boolean }[];
  settings: { enabled: boolean; recipientId: string | null; recipient?: AcquisitionRecipient | null; revision: number };
};
type ReadClient = { rpc(name: string, args: Record<string, Json>): Promise<{data: Json | null;error: {message?: string;code?: string} | null}> };
export class MyLeadsReadError extends Error {
  constructor(public readonly code: 'UNAUTHENTICATED'|'FORBIDDEN'|'FEATURE_DISABLED'|'READ_FAILED'|'INVALID_INPUT',message: string) { super(message); }
}
export async function myLeadsViewer() {
  const client=await createClient();
  const {data:{user}}=await client.auth.getUser();
  if(!user) throw new MyLeadsReadError('UNAUTHENTICATED','Sign in to view My Leads.');
  const memberships=(await getCallerMemberships()).filter(m=>m.user_id===user.id);
  if(memberships.length!==1) throw new MyLeadsReadError('FORBIDDEN','A single active organization is required.');
  return {userId:user.id,orgId:memberships[0].org_id,isOwner:memberships[0].role==='owner',client};
}
async function readRpc<T>(client: unknown,name: string,args: Record<string,Json>): Promise<T> {
  const {data,error}=await (client as ReadClient).rpc(name,args);
  if(error) {
    if(error.message?.includes('FEATURE_DISABLED')) throw new MyLeadsReadError('FEATURE_DISABLED','My Leads is not enabled yet.');
    if(error.code==='42501') throw new MyLeadsReadError('FORBIDDEN','You do not have access to this queue.');
    if(error.code==='22023') throw new MyLeadsReadError('INVALID_INPUT','Refresh the queue or check the selected filters.');
    throw new MyLeadsReadError('READ_FAILED','My Leads could not load. Please retry.');
  }
  if(data===null) throw new MyLeadsReadError('READ_FAILED','My Leads returned no data.');
  return data as T;
}
export async function getAcquisitionRoster(): Promise<{viewer: {userId:string;orgId:string;isOwner:boolean};roster:AcquisitionRoster}> {
  const {client,...viewer}=await myLeadsViewer();
  return {viewer,roster:await readRpc<AcquisitionRoster>(client,'fn_get_acquisition_roster',{p_org_id:viewer.orgId})};
}
export async function getAcquisitionQueue(input: { memberId: string; search?: string; stage?: QueueStage; cursor?: string | null }): Promise<QueueSnapshot> {
  const viewer=await myLeadsViewer();
  if(!viewer.isOwner&&input.memberId!==viewer.userId) throw new MyLeadsReadError('FORBIDDEN','You can view only your own queue.');
  return readRpc<QueueSnapshot>(viewer.client,'fn_get_acquisition_queue_page',{
    p_org_id:viewer.orgId,p_member_id:input.memberId,p_search:input.search??'',p_stage:input.stage??null,p_cursor:input.cursor??null,p_limit:20,
  });
}
export async function getAcquisitionKpis(input: {memberId:string;period:AcquisitionPeriod|'custom';startDate?:string;endDate?:string}): Promise<AcquisitionKpis> {
  const viewer=await myLeadsViewer();
  if(!viewer.isOwner&&input.memberId!==viewer.userId) throw new MyLeadsReadError('FORBIDDEN','You can view only your own KPIs.');
  let bounds;
  try {
    bounds=input.period==='custom'?acquisitionDateRange(input.startDate??'',input.endDate??''):acquisitionPeriodBounds(input.period,new Date());
  } catch { throw new MyLeadsReadError('INVALID_INPUT','Choose a valid reporting date range.'); }
  return readRpc<AcquisitionKpis>(viewer.client,'fn_get_acquisition_kpis',{
    p_org_id:viewer.orgId,p_member_id:input.memberId,p_start:bounds.start.toISOString(),p_end:bounds.end.toISOString(),
  });
}
export async function getAcquisitionBadge(): Promise<number> {
  const viewer=await myLeadsViewer();
  try { return await readRpc<number>(viewer.client,'fn_get_acquisition_badge',{p_org_id:viewer.orgId}); }
  catch(error) { if(error instanceof MyLeadsReadError&&error.code==='FEATURE_DISABLED') return 0; throw error; }
}

export type DetailGroup = 'notes'|'attempts'|'appointments'|'offers'|'history';
export type DetailFact = { id:string; at:string; actorId:string|null; body?:string; outcome?:string|null; source?:string;
  recordingUrl?:string|null; callActivityId?:string|null; amountCents?:number; method?:string; title?:string; status?:string; type?:'appointment'|'callback'; lifecycleState?:'past_due'|'upcoming'|null; callbackActionAllowed?:boolean; currentAssigneeId?:string|null; kind?:string; endedAt?:string|null };
export type AcquisitionDetail = { groups: Partial<Record<DetailGroup,{ rows:DetailFact[];cursor:string|null;hasMore:boolean }>> };
export async function getAcquisitionDetail(input: {memberId:string;propertyId:string;group?:DetailGroup;cursor?:string|null}): Promise<AcquisitionDetail> {
  const viewer=await myLeadsViewer();
  if(!viewer.isOwner&&input.memberId!==viewer.userId) throw new MyLeadsReadError('FORBIDDEN','You can view only your own queue.');
  return readRpc<AcquisitionDetail>(viewer.client,'fn_get_acquisition_detail',{
    p_org_id:viewer.orgId,p_member_id:input.memberId,p_property_id:input.propertyId,p_group:input.group??null,p_cursor:input.cursor??null,
  });
}
