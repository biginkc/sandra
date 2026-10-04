import { describe, expect, it } from 'vitest';
import { detailView, queueRow, stagePages } from './adapter';
import type { AcquisitionDetail, AcquisitionRoster, QueueRow, QueueSnapshot } from '@/lib/my-leads/queries';
import type { MyLeadDripSnapshot } from '@/lib/my-leads/drip-queries';

it('subtracts all active drip rows from their exact stage count and pins replied rows',()=>{
  const base={propertyId:'one',stage:'contacted',address:'1 Main',warningReasons:[],offer:null} as unknown as QueueRow;
  const snapshot={search:'',snapshotAt:'2026-09-29T12:00:00Z',stages:{contacted:{rows:[base],totalCount:3,filteredCount:3,hasMore:false,cursor:null}}} as QueueSnapshot;
  const drip={propertyId:'one',stage:'contacted',queueRow:base,repliedAt:null,sequenceName:'Follow-up',step:2,totalSteps:4} as MyLeadDripSnapshot['active'][number];
  const active={active:[drip],replied:[],repliedCount:0,counts:{not_contacted:0,contacted:1,needs_offer:0,offer_sent:0,under_contract:0}};
  expect(stagePages(snapshot,active).contacted.totalCount).toBe(2);
  expect(stagePages(snapshot,active).contacted.rows).toHaveLength(0);
  const replied={...active,active:[],replied:[{...drip,propertyId:'reply',queueRow:{...base,propertyId:'reply'},repliedAt:'2026-09-29T13:00:00Z'}],repliedCount:1,counts:{...active.counts,contacted:0}};
  expect(stagePages(snapshot,replied).contacted.rows[0]).toMatchObject({propertyId:'reply',dripReply:{sequenceName:'Follow-up'}});
});

it('preserves SMS direction, full text, delivery state, and newest-first pagination',()=>{
  const detail:AcquisitionDetail={groups:{messages:{rows:[
    {id:'recent',at:'2026-09-13T18:00:00Z',actorId:null,body:'Thanks!\nPlease call tomorrow.',direction:'inbound',deliveryStatus:'received',attachmentCount:1},
    {id:'earlier',at:'2026-09-13T17:00:00Z',actorId:null,body:'Would tomorrow work?',direction:'outbound',deliveryStatus:'failed',attachmentCount:0},
  ],hasMore:true,cursor:'earlier-page'}}};
  const messages=detailView(detail,{members:[]} as unknown as AcquisitionRoster).messages;
  expect(messages.rows.map(row=>row.id)).toEqual(['recent','earlier']);
  expect(messages.rows[0]).toMatchObject({body:'Thanks!\nPlease call tomorrow.',direction:'inbound',attachmentCount:1,createdAt:'2026-09-13T18:00:00Z'});
  expect(messages.rows[0].createdLabel).toContain('2026');
  expect(messages.rows[0].createdLabel).toContain('CDT');
  expect(messages.rows[1].deliveryStatus).toBe('failed');
  expect(messages).toMatchObject({hasMore:true,nextCursor:'earlier-page'});
});

describe('appointment lifecycle attribution',()=>{
  it('uses current task assignee for canonical actions while retaining original booking credit',()=>{
    const detail={groups:{appointments:{rows:[{id:'appointment',actorId:'original-rep',currentAssigneeId:'current-rep',type:'appointment',lifecycleState:'upcoming',at:'2026-09-11T18:00:00Z'}],hasMore:false,cursor:null}}} as AcquisitionDetail;
    const roster={members:[]} as unknown as AcquisitionRoster;
    expect(detailView(detail,roster).appointments.rows[0].lifecycleAction).toEqual({taskId:'appointment',assigneeId:'current-rep',state:'upcoming'});
  });
});

describe('queue timing display',()=>{
  const row={propertyId:'lead',stage:'contacted',address:'123 Main St',city:'Austin',state:'TX',episodeKind:'live',assignedAt:'2026-09-11T16:00:00Z',firstCallAt:'2026-09-11T16:12:00Z',clockEligible:true,warningReasons:['missing_next_step'],attemptsCount:1,offer:null} as QueueRow;
  it('uses the server snapshot for assignment age and actual elapsed call duration',()=>{
    const view=queueRow(row,'2026-09-11T18:00:00Z');
    expect(view.assignment.label).toBe('2h ago');
    expect(view.assignment.exactLabel).toContain('2026');
    expect(view.assignment.exactLabel).toContain('CDT');
    expect(view.firstCall.label).toBe('12 min elapsed');
    expect(view.firstCall.exactLabel).toContain('first call');
    expect(view.warningReasons).toEqual(['missing_next_step']);
    expect(view.zillowHref).toContain('zillow.com');
  });
  it.each([{episodeKind:'launch' as const},{assignedAt:null},{clockEligible:false},{firstCallAt:'2026-09-11T15:00:00Z'}])('does not invent timing for excluded or invalid evidence: %o',(change)=>{
    expect(queueRow({...row,...change}).firstCall).toEqual({state:'unavailable',label:null});
  });
  it('keeps pending evidence pending',()=>{
    expect(queueRow({...row,firstCallAt:null}).firstCall.state).toBe('pending');
  });
});

describe('attempt display',()=>{
  it.each([
    ['https://dialpad.com/call/123','https://dialpad.com/call/123'],
    ['javascript:alert(1)',null],
    ['data:text/html,test',null],
    ['https://user:password@example.com/audio',null],
    [null,null],
  ])('reuses source and accepts safe optional recording URL %s',(url,expected)=>{
    const detail={groups:{attempts:{rows:[{id:'attempt',actorId:null,at:'2026-09-11T18:00:00Z',source:'dialpad',outcome:'no_answer',recordingUrl:url}],hasMore:false,cursor:null}}} as AcquisitionDetail;
    const attempt=detailView(detail,{members:[]} as unknown as AcquisitionRoster).attempts.rows[0];
    expect(attempt.sourceLabel).toBe('DialPad');
    expect(attempt.outcomeLabel).toBe('No answer');
    expect(attempt.recordingUrl).toBe(expected);
  });
});

it('retains Sandra call identity for authenticated playback without an external URL',()=>{
  const detail={groups:{attempts:{rows:[{id:'attempt',actorId:null,at:'2026-09-12T18:00:00Z',source:'sandra',callActivityId:'call-123',recordingUrl:null}],hasMore:false,cursor:null}}} as AcquisitionDetail;
  expect(detailView(detail,{members:[]} as unknown as AcquisitionRoster).attempts.rows[0]).toMatchObject({callActivityId:'call-123',recordingUrl:null});
  detail.groups.attempts!.rows[0].source='dialpad';
  expect(detailView(detail,{members:[]} as unknown as AcquisitionRoster).attempts.rows[0].callActivityId).toBeNull();
});

it('displays authorized historical labels without adding historical actors to the member selector',()=>{
 const roster={members:[{id:'rep',label:'Current rep'}]} as AcquisitionRoster;
 const fact={id:'fact',at:'2026-09-13T12:00:00Z',actorId:'colleague',actorLabel:'Former colleague'};
 const detail={groups:{notes:{rows:[{...fact,body:'Note'}]},attempts:{rows:[{...fact,outcome:'reached'}]},history:{rows:[{...fact,kind:'live'}]}}} as unknown as AcquisitionDetail;
 const rendered=detailView(detail,roster);
 expect(rendered.notes.rows[0].authorLabel).toBe('Former colleague');expect(rendered.attempts.rows[0].actorLabel).toBe('Former colleague');expect(rendered.history.rows[0].label).toBe('Assigned to Former colleague');expect(roster.members.map(m=>m.id)).toEqual(['rep']);
});

describe('next step shape',()=>{
  const base={propertyId:'lead',stage:'contacted',address:'1 Main',warningReasons:[],offer:null,nextStepAt:'2026-09-11T18:00:00Z'} as unknown as QueueRow;
  it('builds an appointment with its mode from the two payload fields',()=>{
    expect(queueRow({...base,nextStepType:'appointment',nextStepMode:'in_person'}).nextStep).toMatchObject({kind:'appointment',mode:'in_person',dueAt:'2026-09-11T18:00:00Z'});
    expect(queueRow({...base,nextStepType:'appointment',nextStepMode:'phone'}).nextStep).toMatchObject({kind:'appointment',mode:'phone'});
  });
  it('treats a missing mode as phone (payload before the migration)',()=>{
    expect(queueRow({...base,nextStepType:'appointment'}).nextStep).toMatchObject({kind:'appointment',mode:'phone'});
  });
  it('keeps the legacy callback shape for rows still typed callback',()=>{
    const step=queueRow({...base,nextStepType:'callback'}).nextStep;
    expect(step).toMatchObject({kind:'callback'});
    expect(step).not.toHaveProperty('mode');
  });
  it('has no next step without a time',()=>{
    expect(queueRow({...base,nextStepAt:null,nextStepType:null}).nextStep).toBeNull();
  });
  it('keeps callbackAction only for callback-typed detail rows',()=>{
    const detail={groups:{appointments:{rows:[
      {id:'cb',type:'callback',callbackActionAllowed:true,at:'2026-09-11T18:00:00Z',actorId:null},
      {id:'ap',type:'appointment',mode:'phone',callbackActionAllowed:true,at:'2026-09-11T18:00:00Z',actorId:null},
    ],hasMore:false,cursor:null}}} as AcquisitionDetail;
    const rows=detailView(detail,{members:[]} as unknown as AcquisitionRoster).appointments.rows;
    expect(rows[0].callbackAction).toEqual({taskId:'cb'});
    expect(rows[1].callbackAction).toBeUndefined();
  });
});
