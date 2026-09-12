import { describe, expect, it } from 'vitest';
import { detailView, queueRow } from './adapter';
import type { AcquisitionDetail, AcquisitionRoster, QueueRow } from '@/lib/my-leads/queries';

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
