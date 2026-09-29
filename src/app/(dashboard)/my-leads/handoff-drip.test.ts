import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  viewer: vi.fn(), detail: vi.fn(), admin: vi.fn(), dispo: vi.fn(), start: vi.fn(), rpc: vi.fn(),
}));
vi.mock('@/lib/my-leads/queries', () => ({
  myLeadsViewer: mocks.viewer, getAcquisitionDetail: mocks.detail,
  getAcquisitionQueue: vi.fn(), getAcquisitionKpis: vi.fn(),
}));
vi.mock('@/lib/my-leads/drip-queries', () => ({listMyLeadsInDrip: vi.fn()}));
vi.mock('@/lib/supabase/admin', () => ({createAdminClient: mocks.admin}));
vi.mock('@/app/(dashboard)/messages/dispo-actions', () => ({setOutreachDispo: mocks.dispo}));
vi.mock('@/app/(dashboard)/sequences/actions', () => ({startDripForLeads: mocks.start}));
vi.mock('next/cache', () => ({revalidatePath: vi.fn()}));
import { submitMyLeadHandoffDrip } from './actions';

const input = {memberId:'rep',propertyId:'lead',sequenceId:'drip',reason:'not_interested' as const,
  expectedEpisodeId:'episode',expectedQueueVersion:2,expectedSharedStatus:'active'};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.viewer.mockResolvedValue({userId:'rep',orgId:'org',isOwner:false,client:{rpc:mocks.rpc}});
  mocks.detail.mockResolvedValue({groups:{}});
  mocks.admin.mockReturnValue({from:(name:string) => {
    const query = {
      select:() => query, eq:() => query, is:() => query,
      maybeSingle:async() => ({data:name==='properties'?{id:'lead',status:'active',assigned_user_id:'rep',is_dnc_locked:false,deleted_at:null}
        :name==='acquisition_assignment_episodes'?{id:'episode'}:{version:2,archived_at:null},error:null}),
    };
    return query;
  }});
  mocks.dispo.mockResolvedValue({ok:true});
  mocks.start.mockResolvedValue({ok:true,data:{results:[{propertyId:'lead',status:'enrolled',reason:'Enrolled'}]}});
});

it('saves the outcome, starts the drip, and never calls the reassignment RPC', async () => {
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:true});
  expect(mocks.dispo).toHaveBeenCalledWith('lead','needs_sequence');
  expect(mocks.start).toHaveBeenCalledWith('drip',['lead']);
  expect(mocks.rpc).not.toHaveBeenCalledWith('fn_handoff_acquisition_lead',expect.anything());
});

it('keeps the saved outcome successful when enrollment fails', async () => {
  mocks.start.mockResolvedValue({ok:false,error:{message:'No approved sender'}});
  expect(await submitMyLeadHandoffDrip(input)).toEqual({ok:true,dripFailure:'No approved sender'});
});
