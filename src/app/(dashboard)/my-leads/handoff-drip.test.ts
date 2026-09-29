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
  mocks.rpc.mockResolvedValue({data:null,error:{message:'STALE_ASSIGNMENT'}});
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:false,message:'This lead changed. Refresh before trying again.'});
  expect(mocks.start).not.toHaveBeenCalled();
});

it('keeps the saved outcome successful when enrollment fails',async()=>{
  mocks.start.mockResolvedValue({ok:false,error:{message:'No approved sender'}});
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:true,dripFailure:'No approved sender'});
});

it('rejects another member queue before mutation',async()=>{
  expect((await submitMyLeadHandoffDrip({...input,memberId:'other'})).ok).toBe(false);
  expect(mocks.rpc).not.toHaveBeenCalled();
});
