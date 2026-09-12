import { describe, expect, it } from 'vitest';
import { detailView } from './adapter';
import type { AcquisitionDetail, AcquisitionRoster } from '@/lib/my-leads/queries';

describe('appointment lifecycle attribution',()=>{
  it('uses current task assignee for canonical actions while retaining original booking credit',()=>{
    const detail={groups:{appointments:{rows:[{id:'appointment',actorId:'original-rep',currentAssigneeId:'current-rep',type:'appointment',lifecycleState:'upcoming',at:'2026-09-11T18:00:00Z'}],hasMore:false,cursor:null}}} as AcquisitionDetail;
    const roster={members:[]} as unknown as AcquisitionRoster;
    expect(detailView(detail,roster).appointments.rows[0].lifecycleAction).toEqual({taskId:'appointment',assigneeId:'current-rep',state:'upcoming'});
  });
});
