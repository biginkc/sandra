import type { AcquisitionKpis,AcquisitionRoster,QueueRow,QueueSnapshot,AcquisitionDetail } from '@/lib/my-leads/queries';
import { type MyLeadQueueRow,type MyLeadStage,type MyLeadStagePage,type MyLeadsKpis,type MyLeadDetail } from './_components/types';
const date=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const dollars=new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'});
export const dateLabel=(at:string|null|undefined)=>at?date.format(new Date(at)):'Unavailable';
export function queueRow(row:QueueRow):MyLeadQueueRow {
  return {
    propertyId:row.propertyId,queueStage:row.stage,address:row.address,homeownerName:row.homeownerName,phone:row.phone,
    assignment:{state:row.episodeKind==='launch'?'launch_initialized':row.assignedAt?'known':'unknown',label:row.episodeKind==='launch'?'Existing lead':dateLabel(row.assignedAt)},
    firstCall:{state:row.firstCallAt?'started':row.clockEligible?'pending':'unavailable',label:row.firstCallAt?dateLabel(row.firstCallAt):row.clockEligible?'Awaiting first call':null},
    warningReasons:row.warningReasons as MyLeadQueueRow['warningReasons'],attemptsCount:row.attemptsCount,
    motivation:{temperature:row.temperature,motivationResponseKind:row.motivationKind==='specified'?'provided':row.motivationKind==='no_motivation'?'no_motivation_provided':'unanswered',text:row.motivationText},
    nextStep:row.nextStepAt?{kind:row.nextStepType??'appointment',label:dateLabel(row.nextStepAt)}:null,
    offer:row.offer?{amountLabel:dollars.format(row.offer.amountCents/100),method:row.offer.method,sentLabel:dateLabel(row.offer.sentAt),followUpLabel:dateLabel(row.offer.followUpAt),outcome:row.offer.outcome}:null,
    archived:false,
  };
}
export function stagePages(snapshot:QueueSnapshot):Record<MyLeadStage,MyLeadStagePage> {
  const build=(stage:MyLeadStage):MyLeadStagePage=>({stage,rows:(snapshot.stages[stage]?.rows??[]).map(queueRow),
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
    attempts:wrap('attempts',group('attempts').map(r=>({id:r.id,actorLabel:actor(r.actorId),outcomeLabel:r.outcome??'Outcome pending',occurredLabel:dateLabel(r.at)}))),
    appointments:wrap('appointments',group('appointments').map(r=>({id:r.id,label:r.title??'Appointment',dueLabel:dateLabel(r.at),statusLabel:r.outcome??r.status??'Unknown',callbackAction:r.type==='callback'&&r.callbackActionAllowed?{taskId:r.id}:undefined,lifecycleAction:r.type==='appointment'&&r.currentAssigneeId&&r.lifecycleState?{taskId:r.id,assigneeId:r.currentAssigneeId,state:r.lifecycleState}:undefined}))),
    offers:wrap('offers',group('offers').map(r=>({id:r.id,amountLabel:dollars.format((r.amountCents??0)/100),method:r.method??'',sentLabel:dateLabel(r.at),outcomeLabel:r.outcome??'pending'}))),
    history:wrap('history',group('history').map(r=>({id:r.id,label:`${r.kind==='launch'?'Initialized for':'Assigned to'} ${actor(r.actorId)}${r.endedAt?' (ended)':''}`,createdLabel:dateLabel(r.at)}))),
  };
}
