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
  contactWithoutFollowUp: number; needsOffers: number; appointmentsOverdue: number;
  lastAttemptAt: string | null; asOf: string; missingRecordings: number; recordingExpectationUnknown: number;
  averageTalkSeconds: number | null; talkTimeSamples: number; talkTimeUnknown: number; conversationsOverFiveMinutes: number;
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

export type DetailGroup = 'notes'|'attempts'|'appointments'|'offers'|'history'|'messages';
export type DetailFact = { id:string; at:string; actorId:string|null; body?:string; outcome?:string|null; source?:string;
  direction?:'inbound'|'outbound'; deliveryStatus?:string; attachmentCount?:number;
  recordingUrl?:string|null; callActivityId?:string|null; amountCents?:number; method?:string; title?:string; status?:string; type?:'appointment'|'callback'; lifecycleState?:'past_due'|'upcoming'|null; callbackActionAllowed?:boolean; currentAssigneeId?:string|null; kind?:string; endedAt?:string|null };
export type AcquisitionDetail = { groups: Partial<Record<DetailGroup,{ rows:DetailFact[];cursor:string|null;hasMore:boolean }>> };

const SMS_PAGE_SIZE=20;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SMS_TIMESTAMP=/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
type SmsScope={orgId:string;memberId:string;propertyId:string};
type SmsCursor=SmsScope&{version:1;at:string;id:string};

function decodeSmsCursor(raw:string|null|undefined,scope:SmsScope):SmsCursor|null {
  if(raw==null) return null;
  try {
    if(raw.length>1024||!/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error('Malformed cursor');
    const cursor:unknown=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
    if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)) throw new Error('Malformed cursor');
    const value=cursor as Partial<SmsCursor>;
    if(value.version!==1||value.orgId!==scope.orgId||value.memberId!==scope.memberId||value.propertyId!==scope.propertyId
      ||typeof value.id!=='string'||!UUID.test(value.id)||typeof value.at!=='string'||!SMS_TIMESTAMP.test(value.at)
      ||!Number.isFinite(Date.parse(value.at))) throw new Error('Invalid cursor');
    const date=value.at.slice(0,10);
    if(date.startsWith('0000')||new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)!==date) throw new Error('Invalid cursor date');
    // Preserve PostgreSQL's microseconds; Date.toISOString() would lose the tie-break precision.
    return value as SmsCursor;
  } catch {
    throw new MyLeadsReadError('INVALID_INPUT','Refresh the lead to load its text messages.');
  }
}

async function readAcquisitionSmsHistory(viewer:Awaited<ReturnType<typeof myLeadsViewer>>,scope:SmsScope,rawCursor?:string|null) {
  if(!UUID.test(scope.propertyId)) throw new MyLeadsReadError('INVALID_INPUT','Choose a valid lead.');
  const cursor=decodeSmsCursor(rawCursor,scope);
  // The detail RPC has already authorized this read. Recheck current assignment before
  // deriving the homeowner contact; a contact supplied by the browser is never trusted.
  const {data:property,error:propertyError}=await viewer.client.from('properties')
    .select('homeowner_contact_id').eq('org_id',scope.orgId).eq('id',scope.propertyId)
    .eq('assigned_user_id',scope.memberId).is('deleted_at',null).eq('is_dnc_locked',false).maybeSingle();
  if(propertyError) throw new MyLeadsReadError('READ_FAILED','Text messages could not load. Please retry.');
  if(!property) throw new MyLeadsReadError('FORBIDDEN','This lead is no longer available in the selected queue.');
  const contactId=property.homeowner_contact_id;
  if(contactId!==null&&!UUID.test(contactId)) throw new MyLeadsReadError('READ_FAILED','Text messages could not load. Please retry.');

  let query=viewer.client.from('messages').select('id,created_at,body,direction,status,metadata')
    .eq('org_id',scope.orgId).eq('channel','sms')
    .or('direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered,failed,bounced))');
  // Contact-only texts can predate property linkage. Never include texts explicitly
  // attributed to a different property belonging to the same homeowner.
  query=contactId
    ?query.or(`property_id.eq.${scope.propertyId},and(property_id.is.null,contact_id.eq.${contactId})`)
    :query.eq('property_id',scope.propertyId);
  if(cursor) query=query.or(`created_at.lt.${cursor.at},and(created_at.eq.${cursor.at},id.lt.${cursor.id})`);
  const {data,error}=await query.order('created_at',{ascending:false}).order('id',{ascending:false}).limit(SMS_PAGE_SIZE+1);
  if(error||data===null) throw new MyLeadsReadError('READ_FAILED','Text messages could not load. Please retry.');
  const hasMore=data.length>SMS_PAGE_SIZE;
  const rows:DetailFact[]=data.slice(0,SMS_PAGE_SIZE).map(message=>{
    const metadata=message.metadata;
    const mediaUrls=metadata&&typeof metadata==='object'&&!Array.isArray(metadata)?metadata.mediaUrls:null;
    return {id:message.id,at:message.created_at,actorId:null,body:message.body,
      direction:message.direction as 'inbound'|'outbound',deliveryStatus:message.status,
      attachmentCount:Array.isArray(mediaUrls)?mediaUrls.filter(url=>typeof url==='string'&&url.length>0).length:0};
  });
  const last=rows.at(-1);
  // This scoped cursor is a pagination position, never an authorization token.
  const next=hasMore&&last?Buffer.from(JSON.stringify({...scope,version:1,at:last.at,id:last.id} satisfies SmsCursor)).toString('base64url'):null;
  return {rows,cursor:next,hasMore};
}

export async function getAcquisitionDetail(input: {memberId:string;propertyId:string;group?:DetailGroup;cursor?:string|null}): Promise<AcquisitionDetail> {
  const viewer=await myLeadsViewer();
  if(!viewer.isOwner&&input.memberId!==viewer.userId) throw new MyLeadsReadError('FORBIDDEN','You can view only your own queue.');
  const messagesOnly=input.group==='messages';
  const detail=await readRpc<AcquisitionDetail>(viewer.client,'fn_get_acquisition_detail',{
    p_org_id:viewer.orgId,p_member_id:input.memberId,p_property_id:input.propertyId,
    // The deployed RPC accepts only its original groups and UUID cursors. Use a
    // valid group to authorize every messages page without passing it an SMS cursor.
    p_group:messagesOnly?'history':input.group??null,p_cursor:messagesOnly?null:input.cursor??null,
  });
  if(input.group&&!messagesOnly) return detail;
  const messages=await readAcquisitionSmsHistory(viewer,{orgId:viewer.orgId,memberId:input.memberId,propertyId:input.propertyId},messagesOnly?input.cursor:null);
  return {groups:messagesOnly?{messages}:{...detail.groups,messages}};
}
