import { zillowUrl } from '@/lib/utils/zillow-url';
import type { AcquisitionKpis,AcquisitionRoster,QueueRow,QueueSnapshot,AcquisitionDetail } from '@/lib/my-leads/queries';
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
export function queueRow(row:QueueRow,asOf?:string):MyLeadQueueRow {
  return {
    propertyId:row.propertyId,zillowHref:zillowUrl({address:row.address,city:row.city,state:row.state}),queueStage:row.stage,address:row.address,homeownerName:row.homeownerName,phone:row.phone,
    assignment:{state:row.episodeKind==='launch'?'launch_initialized':row.assignedAt?'known':'unknown',label:row.episodeKind==='launch'?'Existing lead':assignmentAge(row.assignedAt,asOf),exactLabel:row.episodeKind==='launch'?undefined:exactLabel(row.assignedAt)},
    firstCall:firstCall(row),
    warningReasons:row.warningReasons as MyLeadQueueRow['warningReasons'],attemptsCount:row.attemptsCount,
    motivation:{temperature:row.temperature,motivationResponseKind:row.motivationKind==='specified'?'provided':row.motivationKind==='no_motivation'?'no_motivation_provided':'unanswered',text:row.motivationText},
    nextStep:row.nextStepAt?{kind:row.nextStepType??'appointment',label:dateLabel(row.nextStepAt)}:null,
    offer:row.offer?{amountLabel:dollars.format(row.offer.amountCents/100),method:row.offer.method,sentLabel:dateLabel(row.offer.sentAt),followUpLabel:dateLabel(row.offer.followUpAt),outcome:row.offer.outcome}:null,
    archived:false,
  };
}
export function stagePages(snapshot:QueueSnapshot):Record<MyLeadStage,MyLeadStagePage> {
  const build=(stage:MyLeadStage):MyLeadStagePage=>({stage,rows:(snapshot.stages[stage]?.rows??[]).map(row=>queueRow(row,snapshot.snapshotAt)),
    totalCount:snapshot.search?snapshot.stages[stage]?.filteredCount??0:snapshot.stages[stage]?.totalCount??0,hasMore:snapshot.stages[stage]?.hasMore??false});
  return {not_contacted:build('not_contacted'),contacted:build('contacted'),needs_offer:build('needs_offer'),offer_sent:build('offer_sent'),under_contract:build('under_contract')};
}
export function kpiTiles(kpis:AcquisitionKpis):MyLeadsKpis {
  const ratio=(n:number,d:number)=>d?`${Math.round(n/d*100)}% (${n}/${d})`:null;
  return {attempts:kpis.attempts,contactRateLabel:ratio(kpis.reached,kpis.attempts),
    assignToFirstCallLabel:kpis.firstCallSamples&&kpis.firstCallElapsedSeconds!==null?`${Math.round(kpis.firstCallElapsedSeconds/60)} min elapsed`:null,
    appointmentsKeptLabel:ratio(kpis.appointmentsHeld,kpis.appointmentsDue),offersSent:kpis.offersSent,staleLeads:kpis.staleLeads};
}
export function detailView(detail:AcquisitionDetail,roster:AcquisitionRoster):MyLeadDetail {
  const actor=(id:string|null)=>roster.members.find(m=>m.id===id)?.label??'Team member';
  const group=(name:keyof AcquisitionDetail['groups'])=>detail.groups[name]?.rows??[];
  const wrap=<T,>(name:keyof AcquisitionDetail['groups'],rows:T[])=>({rows,hasMore:detail.groups[name]?.hasMore??false,nextCursor:detail.groups[name]?.cursor??null});
  return {
    notes:wrap('notes',group('notes').map(r=>({id:r.id,authorLabel:actor(r.actorId),body:r.body??'',createdLabel:dateLabel(r.at)}))),
    messages:wrap('messages',group('messages').flatMap(r=>r.direction==='inbound'||r.direction==='outbound'?[{id:r.id,body:r.body??'',direction:r.direction,createdAt:r.at,createdLabel:exactLabel(r.at)??'Unavailable',deliveryStatus:r.deliveryStatus??'',attachmentCount:r.attachmentCount??0}]:[])),
    attempts:wrap('attempts',group('attempts').map(r=>({id:r.id,actorLabel:actor(r.actorId),outcomeLabel:({no_answer:'No answer',reached:'Reached',wrong_number:'Wrong number'} as Record<string,string>)[r.outcome??'']??r.outcome??'Outcome pending',occurredLabel:dateLabel(r.at),sourceLabel:({sandra:'Sandra',dialpad:'DialPad',manual:'Manual'} as Record<string,string>)[r.source??''],recordingUrl:recordingUrl(r.recordingUrl),callActivityId:r.source==='sandra'?r.callActivityId??null:null}))),
    appointments:wrap('appointments',group('appointments').map(r=>({id:r.id,label:r.title??'Appointment',dueLabel:dateLabel(r.at),statusLabel:r.outcome??r.status??'Unknown',callbackAction:r.type==='callback'&&r.callbackActionAllowed?{taskId:r.id}:undefined,lifecycleAction:r.type==='appointment'&&r.currentAssigneeId&&r.lifecycleState?{taskId:r.id,assigneeId:r.currentAssigneeId,state:r.lifecycleState}:undefined}))),
    offers:wrap('offers',group('offers').map(r=>({id:r.id,amountLabel:dollars.format((r.amountCents??0)/100),method:r.method??'',sentLabel:dateLabel(r.at),outcomeLabel:r.outcome??'pending'}))),
    history:wrap('history',group('history').map(r=>({id:r.id,label:`${r.kind==='launch'?'Initialized for':'Assigned to'} ${actor(r.actorId)}${r.endedAt?' (ended)':''}`,createdLabel:dateLabel(r.at)}))),
  };
}
