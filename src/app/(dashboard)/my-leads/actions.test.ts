import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({viewer:vi.fn(),rpc:vi.fn(),adminRpc:vi.fn(),dispatch:vi.fn(),revalidate:vi.fn(),report:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('@/lib/errors/report',()=>({reportError:mocks.report}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:mocks.adminRpc})}));
vi.mock('@/lib/messaging/rep-sms',()=>({
  dispatchRepSms:mocks.dispatch,
  createRepSmsObligationFence:(input:{obligationId:string;claimToken:string;claimGeneration:number;actorId:string;propertyId:string;assignmentId:string;toNumber:string;composition:unknown})=>({
    obligationId:input.obligationId,claimToken:input.claimToken,claimGeneration:input.claimGeneration,actorId:input.actorId,
    propertyId:input.propertyId,assignmentId:input.assignmentId,toNumber:input.toNumber,compositionFingerprint:'test-fingerprint',
  }),
}));
vi.mock('@/lib/my-leads/queries',()=>({myLeadsViewer:mocks.viewer,getAcquisitionQueue:vi.fn(),getAcquisitionKpis:vi.fn(),getAcquisitionDetail:vi.fn()}));
vi.mock('@/lib/my-leads/settings',()=>({setAcquisitionDesignation:vi.fn(),setAcquisitionSettings:vi.fn()}));
import { getAcquisitionKpis, getAcquisitionQueue } from '@/lib/my-leads/queries';
import { loadMyLeads, submitMyLeadCommand } from './actions';
beforeEach(()=>{vi.resetAllMocks();mocks.viewer.mockResolvedValue({orgId:'actual-org',userId:'actor',client:{rpc:mocks.rpc}});mocks.rpc.mockResolvedValue({data:{ok:true},error:null});mocks.adminRpc.mockResolvedValue({data:{ok:true},error:null});mocks.dispatch.mockResolvedValue({status:'sent',messageId:'message',externalId:'provider-message'});});
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

it('records a no-answer attempt, claims the exact obligation, and persists provider acceptance',async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:true,attemptId:'attempt-1',obligationId:'obligation-1'},error:null});
  mocks.adminRpc
    .mockResolvedValueOnce({data:{ok:true,state:'sending',obligationId:'obligation-1',claimToken:'claim-1',claimGeneration:1,assignmentId:'sender-1',toNumber:'+18165550123'},error:null})
    .mockResolvedValueOnce({data:{ok:true,state:'accepted'},error:null});
  const result=await submitMyLeadCommand('log-attempt',{
    propertyId:'lead',source:'manual',kind:'outreach',outcome:'no_answer',occurredAt:'2026-09-17T15:00:00.000Z',
    followUp:{policyVersion:1,introId:'mel-maria-assistant-1',introVersion:1,templateId:'no-answer-callback-time',templateVersion:1,
      initialRemainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      remainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      body:'forged body'},
    smsBody:'forged body',
  });
  expect(result).toEqual({ok:true,attemptRecorded:true,followUp:{status:'accepted',message:null}});
  expect(mocks.rpc).toHaveBeenCalledWith('fn_log_acquisition_attempt',{p_input:expect.objectContaining({orgId:'actual-org',smsBody:'Hey, this is Mel, Maria\'s assistant.\n\nMaria wasn\'t able to reach you. What time would work for her to call you back?'} )});
  expect(mocks.adminRpc).toHaveBeenNthCalledWith(1,'fn_claim_authorize_rep_sms_obligation',expect.objectContaining({p_obligation_id:'obligation-1',p_actor_id:'actor'}));
  expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({propertyId:'lead',assignmentId:'sender-1',to:'+18165550123',obligationFence:expect.objectContaining({obligationId:'obligation-1',claimToken:'claim-1',claimGeneration:1,actorId:'actor',propertyId:'lead',assignmentId:'sender-1',toNumber:'+18165550123'})}));
  expect(mocks.adminRpc).toHaveBeenNthCalledWith(2,'fn_record_rep_sms_obligation_result',expect.objectContaining({p_obligation_id:'obligation-1',p_claim_token:'claim-1',p_state:'accepted',p_provider_message_id:'provider-message'}));
});

it('does not dispatch a second SMS when concurrent submissions observe the exact obligation already sending',async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:true,attemptId:'attempt-1',obligationId:'obligation-1'},error:null});
  let claims=0;
  mocks.adminRpc.mockImplementation(async(name:string)=>{
    if(name==='fn_claim_authorize_rep_sms_obligation') {
      claims+=1;
      return claims===1
        ? {data:{ok:true,state:'sending',obligationId:'obligation-1',claimToken:'claim-1',claimGeneration:1,assignmentId:'sender-1',toNumber:'+18165550123'},error:null}
        : {data:{ok:false,state:'sending',obligationId:'obligation-1',reason:'already_in_progress'},error:null};
    }
    return {data:{ok:true,state:'accepted'},error:null};
  });
  const input={propertyId:'lead',source:'manual',kind:'outreach',outcome:'no_answer',occurredAt:'2026-09-17T15:00:00.000Z',
    followUp:{policyVersion:1,introId:'mel-maria-assistant-1',introVersion:1,templateId:'no-answer-callback-time',templateVersion:1,
      initialRemainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      remainder:"Maria wasn't able to reach you. What time would work for her to call you back?",body:'ignored'}} as const;
  const [first,second]=await Promise.all([submitMyLeadCommand('log-attempt',input),submitMyLeadCommand('log-attempt',input)]);
  expect(claims).toBe(2);
  expect(mocks.dispatch).toHaveBeenCalledTimes(1);
  expect([first,second]).toEqual(expect.arrayContaining([
    {ok:true,attemptRecorded:true,followUp:{status:'accepted',message:null}},
    {ok:true,attemptRecorded:true,followUp:{status:'sending',message:'already_in_progress'}},
  ]));
});

it('records a stale dispatch fence as failed_not_dispatched', async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:true,attemptId:'attempt-1',obligationId:'obligation-1'},error:null});
  mocks.adminRpc
    .mockResolvedValueOnce({data:{ok:true,state:'sending',obligationId:'obligation-1',claimToken:'claim-1',claimGeneration:1,assignmentId:'sender-1',toNumber:'+18165550123'},error:null})
    .mockResolvedValueOnce({data:{ok:true,state:'failed_not_dispatched'},error:null});
  mocks.dispatch.mockResolvedValue({status:'provider_failed',messageId:'message',error:'stale dispatch fence',providerAttempted:false});
  const result=await submitMyLeadCommand('log-attempt',{
    propertyId:'lead',source:'manual',kind:'outreach',outcome:'no_answer',occurredAt:'2026-09-17T15:00:00.000Z',
    followUp:{policyVersion:1,introId:'mel-maria-assistant-1',introVersion:1,templateId:'no-answer-callback-time',templateVersion:1,
      initialRemainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      remainder:"Maria wasn't able to reach you. What time would work for her to call you back?",body:'ignored'},
  });
  expect(result).toEqual({ok:true,attemptRecorded:true,followUp:{status:'failed_not_dispatched',message:'stale dispatch fence'}});
  expect(mocks.adminRpc).toHaveBeenNthCalledWith(2,'fn_record_rep_sms_obligation_result',expect.objectContaining({p_state:'failed_not_dispatched'}));
});

it('returns an early delivery callback result truthfully instead of reporting acceptance', async()=>{
  mocks.rpc.mockResolvedValue({data:{ok:true,attemptId:'attempt-early',obligationId:'obligation-early'},error:null});
  mocks.adminRpc
    .mockResolvedValueOnce({data:{ok:true,state:'sending',obligationId:'obligation-early',claimToken:'claim-early',claimGeneration:1,assignmentId:'sender-1',toNumber:'+18165550123'},error:null})
    .mockResolvedValueOnce({data:{ok:true,state:'delivery_failed',providerError:'carrier rejected'},error:null});
  mocks.dispatch.mockResolvedValue({status:'sent',messageId:'message-early',externalId:'provider-early'});
  const result=await submitMyLeadCommand('log-attempt',{
    propertyId:'lead',source:'manual',kind:'outreach',outcome:'no_answer',occurredAt:'2026-09-17T15:00:00.000Z',
    followUp:{policyVersion:1,introId:'mel-maria-assistant-1',introVersion:1,templateId:'no-answer-callback-time',templateVersion:1,
      initialRemainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      remainder:"Maria wasn't able to reach you. What time would work for her to call you back?",body:'ignored'},
  });
  expect(result).toEqual({ok:true,attemptRecorded:true,followUp:{status:'delivery_failed',message:'carrier rejected'}});
});
