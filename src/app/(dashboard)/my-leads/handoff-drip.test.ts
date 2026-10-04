import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({viewer:vi.fn(),start:vi.fn(),rpc:vi.fn(),revalidate:vi.fn()}));
vi.mock('@/lib/my-leads/queries', () => ({myLeadsViewer:mocks.viewer,getAcquisitionDetail:vi.fn(),
  getAcquisitionQueue:vi.fn(),getAcquisitionKpis:vi.fn()}));
vi.mock('@/lib/my-leads/drip-queries', () => ({listMyLeadsInDrip:vi.fn()}));
vi.mock('@/app/(dashboard)/sequences/actions', () => ({startDripForLeads:mocks.start}));
vi.mock('next/cache', () => ({revalidatePath:mocks.revalidate}));
import { submitMyLeadHandoffDrip } from './actions';

const input={memberId:'rep',propertyId:'lead',sequenceId:'drip',reason:'not_interested' as const,
  expectedEpisodeId:'episode',expectedQueueVersion:2,expectedSharedStatus:'active',idempotencyKey:'command'};
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.viewer.mockResolvedValue({userId:'rep',orgId:'org',isOwner:false,client:{rpc:mocks.rpc}});
  mocks.rpc.mockResolvedValue({data:{ok:true},error:null});
  mocks.start.mockResolvedValue({ok:true,data:{results:[{propertyId:'lead',status:'enrolled',reason:'Enrolled'}]}});
});

it('guards and saves the outcome in one RPC before starting the drip',async()=>{
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:true});
  expect(mocks.rpc).toHaveBeenCalledWith('fn_handoff_acquisition_lead_to_drip',{
    p_org_id:'org',p_member_id:'rep',p_property_id:'lead',
    p_expected_episode_id:'episode',p_expected_queue_version:2,p_expected_shared_status:'active',
    p_idempotency_key:'command',
  });
  expect(mocks.rpc.mock.invocationCallOrder[0]).toBeLessThan(mocks.start.mock.invocationCallOrder[0]);
});

it('does not enroll when reassignment wins the race at the write boundary',async()=>{
  mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'STALE_ASSIGNMENT',code:'P0001'}});
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:false,answered:true,certainty:'rejected',code:'STALE_STATE',message:'This lead changed. Refresh before trying again.'});
  expect(mocks.start).not.toHaveBeenCalled();
});

it('keeps the saved outcome successful when enrollment fails',async()=>{
  mocks.start.mockResolvedValue({ok:false,error:{message:'No approved sender'}});
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:true,dripFailure:'No approved sender'});
});

it('rejects another member queue before mutation as an unknown (mutable permission) failure',async()=>{
  expect(await submitMyLeadHandoffDrip({...input,memberId:'other'})).toMatchObject({ok:false,certainty:'unknown'});
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it('reports a committed handoff with a follow-up error when the drip start throws, never as a failure',async()=>{
  mocks.start.mockRejectedValue(new Error('boom after commit'));
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:true,dripFailure:'Could not start the drip.'});
});

it.each([
  ['STALE_STATE','rejected'],['STALE_ASSIGNMENT','rejected'],['FORBIDDEN','unknown'],['fetch failed','unknown'],['IDEMPOTENCY_CONFLICT','unknown'],
])('classifies handoff-drip RPC error %s as %s',async(message,certainty)=>{
  mocks.rpc.mockResolvedValue({data:null,error:{message}});
  expect(await submitMyLeadHandoffDrip(input)).toMatchObject({ok:false,certainty});
});

it('treats a missing confirmation or a thrown RPC as unknown',async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:false},error:null});
  expect(await submitMyLeadHandoffDrip(input)).toMatchObject({ok:false,certainty:'unknown',message:'The update was not confirmed. Retry with the same form.'});
  mocks.rpc.mockRejectedValue(new Error('network'));
  expect(await submitMyLeadHandoffDrip(input)).toMatchObject({ok:false,certainty:'unknown'});
});


it('does not mark a fetch failure (status 0, empty code) as answered',async()=>{
  mocks.rpc.mockResolvedValue({data:null,status:0,error:{message:'TypeError: fetch failed',details:'',hint:'',code:''}});
  const result=await submitMyLeadHandoffDrip(input);
  expect(result).toMatchObject({ok:false,certainty:'unknown'});
  expect(result).not.toHaveProperty('answered');
});
