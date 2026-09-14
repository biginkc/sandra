import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({viewer:vi.fn(),rpc:vi.fn(),revalidate:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('@/lib/my-leads/queries',()=>({myLeadsViewer:mocks.viewer,getAcquisitionQueue:vi.fn(),getAcquisitionKpis:vi.fn(),getAcquisitionDetail:vi.fn()}));
vi.mock('@/lib/my-leads/settings',()=>({setAcquisitionDesignation:vi.fn(),setAcquisitionSettings:vi.fn()}));
import { getAcquisitionKpis, getAcquisitionQueue } from '@/lib/my-leads/queries';
import { loadMyLeadCallReferences, loadMyLeads, submitMyLeadCommand } from './actions';
beforeEach(()=>{vi.resetAllMocks();mocks.viewer.mockResolvedValue({orgId:'actual-org',userId:'actor',client:{rpc:mocks.rpc}});mocks.rpc.mockResolvedValue({data:{ok:true},error:null});});
describe('My Leads command integration',()=>{
  it('injects the authenticated organization, overriding client input',async()=>{
    expect(await submitMyLeadCommand('log-offer',{orgId:'forged-org',propertyId:'lead',amountCents:100})).toEqual({ok:true});
    expect(mocks.rpc).toHaveBeenCalledWith('fn_log_acquisition_offer',{p_input:{orgId:'actual-org',propertyId:'lead',amountCents:100}});
  });
  it('finalizes an existing Sandra call instead of logging another attempt',async()=>{
    await submitMyLeadCommand('log-attempt',{propertyId:'lead',source:'sandra',callActivityId:'activity'});
    expect(mocks.rpc).toHaveBeenCalledWith('fn_finalize_acquisition_attempt',{p_input:{orgId:'actual-org',propertyId:'lead',source:'sandra',callActivityId:'activity'}});
  });
  it('rejects an unscoped caller before any write',async()=>{
    mocks.viewer.mockRejectedValue(new Error('No membership'));
    expect((await submitMyLeadCommand('archive',{propertyId:'lead'})).ok).toBe(false);expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('does not revalidate or report success for a rejected stale command',async()=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message:'STALE_ASSIGNMENT'}});
    expect(await submitMyLeadCommand('handoff',{propertyId:'lead'})).toEqual({ok:false,code:'STALE_STATE',message:'This lead changed. Refresh before trying again.'});
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

it('keeps KPI scope at today for the rep regardless of search and obsolete period inputs',async()=>{
  await loadMyLeads({memberId:'rep',search:'filtered lead',period:'custom',startDate:'2020-01-01',endDate:'2020-01-02'});
  expect(getAcquisitionKpis).toHaveBeenCalledWith({memberId:'rep',period:'today'});
  expect(getAcquisitionQueue).toHaveBeenCalledWith(expect.objectContaining({search:'filtered lead'}));
});

it('finalizes evidenced Dialpad references while preserving manual Dialpad logging',async()=>{
  await submitMyLeadCommand('log-attempt',{source:'dialpad',callActivityId:'activity',outcome:'reached'});
  expect(mocks.rpc).toHaveBeenLastCalledWith('fn_finalize_acquisition_attempt',{p_input:{orgId:'actual-org',source:'dialpad',callActivityId:'activity',outcome:'reached'}});
  await submitMyLeadCommand('log-attempt',{source:'dialpad',callActivityId:null,outcome:'no_answer'});
  expect(mocks.rpc).toHaveBeenLastCalledWith('fn_log_acquisition_attempt',expect.anything());
});
it('preserves source on pending call options',async()=>{
  mocks.rpc.mockResolvedValue({data:[{id:'call',occurredAt:'2026-09-13T12:00:00Z',source:'dialpad'}],error:null});
  expect(await loadMyLeadCallReferences('lead','actor')).toMatchObject({ok:true,options:[{id:'call',source:'dialpad'}]});
});
it('returns safe typed access guidance without revealing assignment or revalidating', async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{message:'FORBIDDEN'}});
  expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toEqual({ok:false,code:'FORBIDDEN',message:'This lead is unavailable or you no longer have access. Refresh to check access. Your draft is retained.'});
  expect(mocks.revalidate).not.toHaveBeenCalled();
});
