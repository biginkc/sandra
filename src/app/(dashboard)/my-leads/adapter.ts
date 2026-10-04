import { zillowUrl } from '@/lib/utils/zillow-url';
import type { AcquisitionKpis,AcquisitionRoster,QueueRow,QueueSnapshot,AcquisitionDetail } from '@/lib/my-leads/queries';
import type { MyLeadDripSnapshot } from '@/lib/my-leads/drip-queries';
import { type MyLeadQueueRow,type MyLeadStage,type MyLeadStagePage,type MyLeadsKpis,type MyLeadDetail } from './_components/types';
const date=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
export const dateLabel=(at:string|null|undefined)=>at?date.format(new Date(at)):'Unavailable';
const exactDate=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',second:'2-digit',timeZoneName:'short'});
const timestamp=(at:string|null|undefined)=>at?Date.parse(at):NaN;
const exactLabel=(at:string|null|undefined)=>Number.isFinite(timestamp(at))?exactDate.format(new Date(at!)):undefined;
function assignmentAge(at:string|null,asOf:string|undefined) {
  const age=timestamp(asOf)-timestamp(at);
  if(!Number.isFinite(age)||age<0) return dateLabel(at);
  const minutes=Math.floor(age/60000);
  if(minutes<1) return 'Just now';
  if(minutes<60) return `${minutes}m ago`;
  if(minutes<1440) return `${Math.floor(minutes/60)}h ago`;
  return `${Math.floor(minutes/1440)}d ago`;
}
function firstCall(row:QueueRow):MyLeadQueueRow['firstCall'] {
  const elapsed=timestamp(row.firstCallAt)-timestamp(row.assignedAt);
  if(row.episodeKind==='launch'||!row.clockEligible||!Number.isFinite(timestamp(row.assignedAt))) return {state:'unavailable',label:null};
  if(!row.firstCallAt) return {state:'pending',label:'Awaiting first call'};
  if(!Number.isFinite(elapsed)||elapsed<0) return {state:'unavailable',label:null};
  const minutes=Math.floor(elapsed/60000);
  const duration=minutes<1?'<1 min':minutes<60?`${minutes} min`:minutes<1440?`${Math.floor(minutes/60)}h ${minutes%60}m`:`${Math.floor(minutes/1440)}d ${Math.floor(minutes%1440/60)}h`;
  return {state:'started',label:`${duration} elapsed`,exactLabel:`Assigned ${exactLabel(row.assignedAt)}; first call ${exactLabel(row.firstCallAt)}`};
}
/** Optional external recordings must never become executable or credential-bearing links. */
function recordingUrl(value:string|null|undefined):string|null {
  if(!value) return null;
  try { const url=new URL(value); return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:null; } catch { return null; }
}
function nextStep(row:QueueRow):MyLeadQueueRow['nextStep'] {
  if(!row.nextStepAt) return null;
  const label=dateLabel(row.nextStepAt);
  const dueAt=row.nextStepAt;
  // Legacy payload (migration not applied yet): rows still typed callback keep the old shape.
  if(row.nextStepType==='callback') return {kind:'callback',label,dueAt};
  return {kind:'appointment',mode:row.nextStepMode==='in_person'?'in_person':'phone',label,dueAt};
}
export function queueRow(row:QueueRow,asOf?:string):MyLeadQueueRow {
  return {
    propertyId:row.propertyId,zillowHref:zillowUrl({address:row.address,city:row.city,state:row.state}),queueStage:row.stage,address:row.address,homeownerName:row.homeownerName,phone:row.phone,
    assignment:{state:row.episodeKind==='launch'?'launch_initialized':row.assignedAt?'known':'unknown',label:row.episodeKind==='launch'?'Existing lead':assignmentAge(row.assignedAt,asOf),exactLabel:row.episodeKind==='launch'?undefined:exactLabel(row.assignedAt)},
    firstCall:firstCall(row),
    warningReasons:row.warningReasons as MyLeadQueueRow['warningReasons'],attemptsCount:row.attemptsCount,
    motivation:{temperature:row.temperature,motivationResponseKind:row.motivationKind==='specified'?'provided':row.motivationKind==='no_motivation'?'no_motivation_provided':'unanswered',text:row.motivationText},
    nextStep:nextStep(row),
    offer:row.offer?{amountLabel:dollars.format(row.offer.amountCents/100),method:row.offer.method,sentLabel:dateLabel(row.offer.sentAt),followUpLabel:dateLabel(row.offer.followUpAt),outcome:row.offer.outcome}:null,
    archived:false,
  };
}
export function stagePages(snapshot:QueueSnapshot,drips?:MyLeadDripSnapshot|null):Record<MyLeadStage,MyLeadStagePage> {
  const activeIds=new Set(drips?.active.map(row=>row.propertyId)??[]);
  const replied=new Map(drips?.replied.map(row=>[row.propertyId,row])??[]);
  const build=(stage:MyLeadStage):MyLeadStagePage=>{
    const loaded=snapshot.stages[stage]?.rows??[];
    const loadedIds=new Set(loaded.map(row=>row.propertyId));
    const pinned=drips?.replied.filter(row=>row.stage===stage&&!loadedIds.has(row.propertyId)&&row.queueRow).map(row=>row.queueRow!)??[];
    const rows=[...pinned,...loaded].filter(row=>!activeIds.has(row.propertyId)).map(row=>({
      ...queueRow(row,snapshot.snapshotAt),dripReply:replied.get(row.propertyId)??null,
    }));
    rows.sort((a,b)=>Number(Boolean(b.dripReply))-Number(Boolean(a.dripReply)) ||
      (b.dripReply?.repliedAt??'').localeCompare(a.dripReply?.repliedAt??''));
    const rpcCount=snapshot.search?snapshot.stages[stage]?.filteredCount??0:snapshot.stages[stage]?.totalCount??0;
    return {stage,rows,totalCount:Math.max(0,rpcCount-(drips?.counts[stage]??0)),hasMore:snapshot.stages[stage]?.hasMore??false};
  };
  return {not_contacted:build('not_contacted'),contacted:build('contacted'),needs_offer:build('needs_offer'),offer_sent:build('offer_sent'),under_contract:build('under_contract')};
}
export function kpiTiles(kpis:AcquisitionKpis):MyLeadsKpis {
  return {...kpis};
}
export function detailView(detail:AcquisitionDetail,roster:AcquisitionRoster):MyLeadDetail {
  const actor=(id:string|null)=>roster.members.find(m=>m.id===id)?.label??'Team member';
  const group=(name:keyof AcquisitionDetail['groups'])=>detail.groups[name]?.rows??[];
  const wrap=<T,>(name:keyof AcquisitionDetail['groups'],rows:T[])=>({rows,hasMore:detail.groups[name]?.hasMore??false,nextCursor:detail.groups[name]?.cursor??null});
  return {
    notes:wrap('notes',group('notes').map(r=>({id:r.id,authorLabel:r.actorLabel??actor(r.actorId),body:r.body??'',createdLabel:dateLabel(r.at)}))),
    messages:wrap('messages',group('messages').flatMap(r=>r.direction==='inbound'||r.direction==='outbound'?[{id:r.id,body:r.body??'',direction:r.direction,createdAt:r.at,createdLabel:exactLabel(r.at)??'Unavailable',deliveryStatus:r.deliveryStatus??'',attachmentCount:r.attachmentCount??0}]:[])),
    attempts:wrap('attempts',group('attempts').map(r=>({id:r.id,actorLabel:r.actorLabel??actor(r.actorId),outcomeLabel:({no_answer:'No answer',reached:'Reached',wrong_number:'Wrong number'} as Record<string,string>)[r.outcome??'']??r.outcome??'Outcome pending',occurredLabel:dateLabel(r.at),sourceLabel:({sandra:'Sandra',dialpad:'DialPad',manual:'Manual'} as Record<string,string>)[r.source??''],recordingUrl:recordingUrl(r.recordingUrl),callActivityId:r.source==='sandra'?r.callActivityId??null:null,followUpObligationId:r.followUpObligationId??null,followUpStatus:r.followUpStatus??null,followUpMessage:r.followUpMessage??null,followUpBlockedReason:r.followUpBlockedReason??null}))),
    appointments:wrap('appointments',group('appointments').map(r=>({id:r.id,label:r.title??'Appointment',dueLabel:dateLabel(r.at),dueAt:r.at,taskType:r.type,statusLabel:r.outcome??r.status??'Unknown',callbackAction:r.type==='callback'&&r.callbackActionAllowed?{taskId:r.id}:undefined,lifecycleAction:r.type==='appointment'&&r.currentAssigneeId&&r.lifecycleState?{taskId:r.id,assigneeId:r.currentAssigneeId,state:r.lifecycleState}:undefined}))),
    offers:wrap('offers',group('offers').map(r=>({id:r.id,amountLabel:dollars.format((r.amountCents??0)/100),method:r.method??'',sentLabel:dateLabel(r.at),outcomeLabel:r.outcome??'pending'}))),
    history:wrap('history',group('history').map(r=>({id:r.id,label:`${r.kind==='launch'?'Initialized for':'Assigned to'} ${r.actorLabel??actor(r.actorId)}${r.endedAt?' (ended)':''}`,createdLabel:dateLabel(r.at)}))),
  };
}
