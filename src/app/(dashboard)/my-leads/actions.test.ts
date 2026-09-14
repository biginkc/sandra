import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({viewer:vi.fn(),rpc:vi.fn(),revalidate:vi.fn(),report:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('@/lib/errors/report',()=>({reportError:mocks.report}));
vi.mock('@/lib/my-leads/queries',()=>({myLeadsViewer:mocks.viewer,getAcquisitionQueue:vi.fn(),getAcquisitionKpis:vi.fn(),getAcquisitionDetail:vi.fn()}));
vi.mock('@/lib/my-leads/settings',()=>({setAcquisitionDesignation:vi.fn(),setAcquisitionSettings:vi.fn()}));
import { getAcquisitionKpis, getAcquisitionQueue } from '@/lib/my-leads/queries';
import { loadMyLeads, submitMyLeadCommand } from './actions';
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

it('returns safe typed access guidance without revealing assignment or revalidating', async()=>{
  mocks.rpc.mockResolvedValue({data:null,error:{message:'FORBIDDEN'}});
  expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toEqual({ok:false,code:'FORBIDDEN',message:'This lead is unavailable or you no longer have access. Refresh to check access. Your draft is retained.'});
  expect(mocks.revalidate).not.toHaveBeenCalled();
});

it('reports a failed queue read with fixed diagnostic fields and preserves the recovery result',async()=>{
  vi.mocked(getAcquisitionQueue).mockRejectedValueOnce(new Error('Private lead name and phone'));
  const result=await loadMyLeads({memberId:'private-member',search:'private filter',period:'today'});
  expect(result.ok).toBe(false);
  expect(mocks.report).toHaveBeenCalledOnce();
  const [diagnostic,context]=mocks.report.mock.calls[0];
  expect(diagnostic.message).toBe('My Leads read failed');
  expect(context).toEqual({errorClass:'database',tags:{surface:'server',operation:'my_leads_queue',kind:'read_failure'}});
});
