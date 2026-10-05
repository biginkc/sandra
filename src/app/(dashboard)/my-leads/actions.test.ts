import { beforeEach,describe,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({drips:vi.fn(),callNext:vi.fn(),viewer:vi.fn(),rpc:vi.fn(),adminRpc:vi.fn(),adminFrom:vi.fn(),dispatch:vi.fn(),revalidate:vi.fn(),report:vi.fn(),queueRow:vi.fn(),createNote:vi.fn(),createStep:vi.fn(),ready:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:mocks.revalidate}));
vi.mock('@/lib/errors/report',()=>({reportError:mocks.report}));
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({rpc:mocks.adminRpc,from:mocks.adminFrom})}));
vi.mock('@/lib/messaging/rep-sms',()=>({
  dispatchRepSms:mocks.dispatch,
  createRepSmsObligationFence:(input:{obligationId:string;claimToken:string;claimGeneration:number;actorId:string;propertyId:string;assignmentId:string;toNumber:string;composition:unknown})=>({
    obligationId:input.obligationId,claimToken:input.claimToken,claimGeneration:input.claimGeneration,actorId:input.actorId,
    propertyId:input.propertyId,assignmentId:input.assignmentId,toNumber:input.toNumber,compositionFingerprint:'test-fingerprint',
  }),
}));
vi.mock('@/lib/my-leads/queries',()=>({myLeadsViewer:mocks.viewer,getMyLeadsQueueRow:mocks.queueRow,getAcquisitionQueue:vi.fn(),getAcquisitionKpis:vi.fn(),getAcquisitionDetail:vi.fn()}));
vi.mock('@/lib/my-leads/drip-queries',()=>({listMyLeadsInDrip:mocks.drips}));
vi.mock('@/lib/my-leads/lead-note',()=>({createIdempotentLeadNote:mocks.createNote}));
vi.mock('@/lib/next-steps',()=>({createNextStep:mocks.createStep}));
vi.mock('@/lib/my-leads/schema-ready',()=>({schemaReady:mocks.ready}));
vi.mock('@/lib/my-leads/call-next',()=>({getCallNext:mocks.callNext}));
vi.mock('@/lib/my-leads/settings',()=>({setAcquisitionDesignation:vi.fn(),setAcquisitionSettings:vi.fn()}));
import { getAcquisitionKpis, getAcquisitionQueue } from '@/lib/my-leads/queries';
import { loadMyLeadCallReferences, loadMyLeads, savePostCallExtras, submitMyLeadCommand } from './actions';
beforeEach(()=>{vi.resetAllMocks();mocks.callNext.mockResolvedValue(null);mocks.drips.mockResolvedValue({active:[],replied:[],repliedCount:0,counts:{}});mocks.viewer.mockResolvedValue({orgId:'actual-org',userId:'actor',client:{rpc:mocks.rpc}});mocks.rpc.mockResolvedValue({data:{ok:true},error:null});mocks.adminRpc.mockResolvedValue({data:{ok:true},error:null});mocks.dispatch.mockResolvedValue({status:'sent',messageId:'message',externalId:'provider-message'});});
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
  it.each([
    ['STALE_STATE','rejected'],['STALE_ASSIGNMENT','rejected'],['FORBIDDEN','unknown'],['DNC_LOCKED','rejected'],
    ['fetch failed','unknown'],['JWT expired','unknown'],['IDEMPOTENCY_CONFLICT','unknown'],
  ])('classifies command RPC error %s as %s',async(message,certainty)=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message}});
    expect(await submitMyLeadCommand('log-offer',{propertyId:'lead'})).toMatchObject({ok:false,certainty});
  });
  it.each(['INVALID_INPUT','INVALID_INPUT: MOTIVATION required','UNAUTHENTICATED','RECORDING_REQUIRED'])('classifies SQL %s as unknown (raised before the receipt lookup or not proof)',async message=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message}});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toMatchObject({ok:false,certainty:'unknown'});
  });
  it.each(['FEATURE_DISABLED','NOT_FOUND','DNC_LOCKED','PENDING_OFFER_EXISTS','RECIPIENT_UNAVAILABLE','PROVIDER_EVIDENCE_PENDING'])('classifies SQL %s as rejected (raised after the receipt lookup)',async message=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message}});
    expect(await submitMyLeadCommand('log-offer',{propertyId:'lead'})).toMatchObject({ok:false,certainty:'rejected'});
  });
  it('shows sign-in guidance for an expired session and keeps it unknown',async()=>{
    mocks.viewer.mockRejectedValue(Object.assign(new Error('Sign in'),{code:'UNAUTHENTICATED'}));
    expect(await submitMyLeadCommand('log-offer',{propertyId:'lead'})).toEqual({ok:false,certainty:'unknown',code:'UNAUTHENTICATED',message:'Your session expired. Sign in again, then Reconcile.'});
  });
  describe('managerless no-answer receipt lookup',()=>{
    const managerless={propertyId:'lead',outcome:'no_answer',idempotencyKey:'key-1',followUp:{templateId:'no-answer-callback-time',introId:'default',remainder:''}};
    const lookup=(result:unknown,throws=false)=>mocks.adminFrom.mockReturnValue({select:()=>({eq:()=>({eq:()=>({eq:()=>({eq:()=>({maybeSingle:async()=>{if(throws)throw new Error('admin down');return result;}})})})})})});
    it('a template error is rejected',async()=>{
      expect(await submitMyLeadCommand('log-attempt',{...managerless,followUp:{introId:'default'}})).toMatchObject({ok:false,certainty:'rejected',message:'Choose a curated follow-up template.'});
      expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('a confirmed missing receipt is rejected',async()=>{
      lookup({data:null,error:null});
      expect(await submitMyLeadCommand('log-attempt',managerless)).toMatchObject({ok:false,certainty:'rejected',message:'Enter the acquisitions manager.'});
      expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('a lookup error is unknown',async()=>{
      lookup({data:null,error:{message:'timeout'}});
      expect(await submitMyLeadCommand('log-attempt',managerless)).toMatchObject({ok:false,certainty:'unknown'});
      expect(mocks.rpc).not.toHaveBeenCalled();
    });
    it('an admin client that throws is unknown',async()=>{
      lookup(null,true);
      expect(await submitMyLeadCommand('log-attempt',managerless)).toMatchObject({ok:false,certainty:'unknown'});
    });
  });
  it('marks only RPC error responses as answered, never transport failures, thrown calls or missing confirmation',async()=>{
    mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'INVALID_INPUT: occurredAt cannot be in the future',code:'P0001'}});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toMatchObject({ok:false,answered:true,certainty:'unknown'});
    mocks.rpc.mockRejectedValue(new Error('network'));
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).not.toHaveProperty('answered');
    mocks.rpc.mockResolvedValue({data:{ok:false},error:null});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).not.toHaveProperty('answered');
    mocks.viewer.mockRejectedValue(new Error('No session'));
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).not.toHaveProperty('answered');
  });
  describe('transport failures never count as answered (installed postgrest-js shapes)',()=>{
    // postgrest-js 2.104 resolves a failed fetch as { error: { message: 'TypeError: fetch failed', details, hint, code: '' }, status: 0 }.
    const transport={data:null,status:0,statusText:'',error:{message:'TypeError: fetch failed',details:'',hint:'',code:''}};
    it('a fetch failure resolved as status 0 with an empty code is not answered, for commands and for the drip handoff',async()=>{
      mocks.rpc.mockResolvedValue(transport);
      const result=await submitMyLeadCommand('log-attempt',{propertyId:'lead'});
      expect(result).toMatchObject({ok:false,certainty:'unknown'});
      expect(result).not.toHaveProperty('answered');
    });
    it('an aborted request and a gateway page without a SQLSTATE are not answered',async()=>{
      mocks.rpc.mockResolvedValue({...transport,error:{...transport.error,message:'AbortError: aborted',hint:'Request was aborted (timeout or manual cancellation)'}});
      expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).not.toHaveProperty('answered');
      mocks.rpc.mockResolvedValue({data:null,status:502,error:{message:'<html>Bad Gateway</html>'}});
      expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).not.toHaveProperty('answered');
    });
    it('a PostgREST-level error code (PGRST...) is not a raised SQLSTATE and is not answered',async()=>{
      mocks.rpc.mockResolvedValue({data:null,status:401,error:{message:'JWT expired',code:'PGRST301'}});
      expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).not.toHaveProperty('answered');
    });
    it('a raised SQLSTATE with an HTTP status is answered',async()=>{
      mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'STALE_STATE',code:'P0001'}});
      expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toMatchObject({ok:false,answered:true,certainty:'rejected'});
    });
    it('status 0 with a SQLSTATE-looking code is still not answered',async()=>{
      mocks.rpc.mockResolvedValue({data:null,status:0,error:{message:'STALE_STATE',code:'P0001'}});
      expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).not.toHaveProperty('answered');
    });
  });
  it('tags the deterministic validation answers with their code',async()=>{
    mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'INVALID_INPUT: MOTIVATION required',code:'P0001'}});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toMatchObject({ok:false,answered:true,code:'MOTIVATION_REQUIRED'});
    mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'RECORDING_REQUIRED',code:'P0001'}});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toMatchObject({ok:false,answered:true,code:'RECORDING_REQUIRED'});
  });
  it('maps a SQL UNAUTHENTICATED to the sign-in guidance, unknown',async()=>{
    mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'UNAUTHENTICATED',code:'P0001'}});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toMatchObject({ok:false,answered:true,certainty:'unknown',code:'UNAUTHENTICATED',message:'Your session expired. Sign in again, then Reconcile.'});
  });
  it('maps ALREADY_FINALIZED (second prompt, other key) to a definite already-saved answer that keeps the extras unwritten',async()=>{
    mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'ALREADY_FINALIZED',code:'MLS01'}});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toEqual({ok:false,answered:true,certainty:'rejected',code:'ALREADY_FINALIZED',message:'This was already saved. Refresh to see it.'});
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it('maps IDEMPOTENCY_CONFLICT to the already-saved answer',async()=>{
    mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'IDEMPOTENCY_CONFLICT',code:'P0001'}});
    expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toEqual({ok:false,answered:true,certainty:'unknown',code:'IDEMPOTENCY_CONFLICT',message:'This was already saved. Refresh to see it.'});
  });
  it('is unknown for a thrown RPC, a session failure and a missing confirmation',async()=>{
    mocks.rpc.mockRejectedValue(new Error('network'));
    expect(await submitMyLeadCommand('log-offer',{propertyId:'lead'})).toMatchObject({ok:false,certainty:'unknown'});
    mocks.rpc.mockResolvedValue({data:{ok:false},error:null});
    expect(await submitMyLeadCommand('log-offer',{propertyId:'lead'})).toMatchObject({ok:false,certainty:'unknown',message:'The update was not confirmed. Retry with the same form.'});
    mocks.viewer.mockRejectedValue(new Error('No session'));
    expect(await submitMyLeadCommand('log-offer',{propertyId:'lead'})).toMatchObject({ok:false,certainty:'unknown'});
  });
  it('keeps a committed save a success when revalidation throws',async()=>{
    mocks.revalidate.mockImplementation(()=>{throw new Error('revalidate failed');});
    expect(await submitMyLeadCommand('log-offer',{propertyId:'lead'})).toEqual({ok:true});
  });
  it.each(['STALE_STATE','STALE_ASSIGNMENT'])('treats %s as a definite answer: exactly one RPC call, returned immediately',async message=>{
    mocks.rpc.mockResolvedValue({data:null,error:{message,code:'40001'}});
    const result=await submitMyLeadCommand('log-attempt',{propertyId:'lead',outcome:'reached',expectedSharedStatus:'interested'});
    expect(result).toMatchObject({ ok: false, certainty: "rejected", code: 'STALE_STATE'});
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.adminRpc).not.toHaveBeenCalled();
  });
  it('does not revalidate or report success for a rejected stale command',async()=>{
    mocks.rpc.mockResolvedValue({data:null,status:400,error:{message:'STALE_ASSIGNMENT',code:'P0001'}});
    expect(await submitMyLeadCommand('handoff',{propertyId:'lead'})).toEqual({ok:false,answered:true,certainty:'rejected',code:'STALE_STATE',message:'This lead changed. Refresh before trying again.'});
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

it('keeps KPI scope at today for the rep regardless of search and obsolete period inputs',async()=>{
  await loadMyLeads({memberId:'rep',search:'filtered lead',period:'custom',startDate:'2020-01-01',endDate:'2020-01-02'});
  expect(getAcquisitionKpis).toHaveBeenCalledWith({memberId:'rep',period:'today'});
  expect(getAcquisitionQueue).toHaveBeenCalledWith(expect.objectContaining({search:'filtered lead'}));
});

it('adds the Call next strip to the refresh, null when it is off',async()=>{
  vi.mocked(getAcquisitionQueue).mockResolvedValue({stages:{},snapshotAt:'2026-10-05T12:00:00Z'} as never);
  vi.mocked(getAcquisitionKpis).mockResolvedValue({} as never);
  const strip={rows:[],excluded:[],hiddenCount:0,snapshotAt:'2026-10-05T12:00:00Z'};
  mocks.callNext.mockResolvedValueOnce(strip);
  expect(await loadMyLeads({memberId:'rep',search:'',period:'today'})).toMatchObject({ok:true,strip});
  expect(mocks.callNext).toHaveBeenCalledWith({memberId:'rep'});
  mocks.callNext.mockResolvedValueOnce(null);
  expect(await loadMyLeads({memberId:'rep',search:'',period:'today'})).toMatchObject({ok:true,strip:null});
});

it('a failed strip read leaves the queue loading and is reported once with fixed fields',async()=>{
  vi.mocked(getAcquisitionQueue).mockResolvedValue({stages:{},snapshotAt:'2026-10-05T12:00:00Z'} as never);
  vi.mocked(getAcquisitionKpis).mockResolvedValue({} as never);
  mocks.callNext.mockRejectedValueOnce(new Error('Private lead name and phone'));
  const result=await loadMyLeads({memberId:'rep',search:'',period:'today'});
  expect(result).toMatchObject({ok:true,strip:undefined});
  expect(mocks.report).toHaveBeenCalledOnce();
  expect(mocks.report.mock.calls[0][1]).toEqual({errorClass:'database',tags:{surface:'server',operation:'my_leads_call_next',kind:'read_failure'}});
});

it('returns safe typed access guidance without revealing assignment or revalidating', async()=>{
  mocks.rpc.mockResolvedValue({data:null,status:403,error:{message:'FORBIDDEN',code:'42501'}});
  expect(await submitMyLeadCommand('log-attempt',{propertyId:'lead'})).toEqual({ok:false,answered:true,certainty:'unknown',code:'FORBIDDEN',message:'This lead is unavailable or you no longer have access. Refresh to check access. Your draft is retained.'});
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
    followUp:{acquisitionsManager:'Maria',policyVersion:1,introId:'mel-maria-assistant-1',introVersion:2,templateId:'no-answer-callback-time',templateVersion:1,
      initialRemainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      remainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      body:'forged body'},
    smsBody:'forged body',
  });
  expect(result).toEqual({ok:true,attemptRecorded:true,followUp:{status:'accepted',message:null}});
  expect(mocks.rpc).toHaveBeenCalledWith('fn_log_acquisition_attempt',{p_input:expect.objectContaining({orgId:'actual-org',smsBody:'Hey, this is Mel with BMH, Maria\'s assistant.\n\nMaria wasn\'t able to reach you. What time would work for her to call you back?'} )});
  expect(mocks.adminRpc).toHaveBeenNthCalledWith(1,'fn_claim_authorize_rep_sms_obligation',expect.objectContaining({p_obligation_id:'obligation-1',p_actor_id:'actor'}));
  expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({propertyId:'lead',assignmentId:'sender-1',to:'+18165550123',obligationFence:expect.objectContaining({obligationId:'obligation-1',claimToken:'claim-1',claimGeneration:1,actorId:'actor',propertyId:'lead',assignmentId:'sender-1',toNumber:'+18165550123'})}));
  expect(mocks.adminRpc).toHaveBeenNthCalledWith(2,'fn_record_rep_sms_obligation_result',expect.objectContaining({p_obligation_id:'obligation-1',p_claim_token:'claim-1',p_state:'accepted',p_provider_message_id:'provider-message'}));
});

it('preserves the original RPC payload when reconciling an existing managerless attempt',async()=>{
  const lookup={select:vi.fn().mockReturnThis(),eq:vi.fn().mockReturnThis(),maybeSingle:vi.fn().mockResolvedValue({data:{id:'receipt-1'},error:null})};
  mocks.adminFrom.mockReturnValue(lookup);
  const result=await submitMyLeadCommand('log-attempt',{
    propertyId:'lead',source:'manual',outcome:'no_answer',idempotencyKey:'11111111-1111-4111-8111-111111111111',
    followUp:{policyVersion:1,introId:'mel-maria-assistant-1',introVersion:2,templateId:'no-answer-callback-time',templateVersion:1,
      initialRemainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      remainder:"Maria wasn't able to reach you. What time would work for her to call you back?",body:'old body'},
  });
  expect(result.ok).toBe(true);
  const payload=mocks.rpc.mock.calls[0][1].p_input;
  expect(payload.followUp).not.toHaveProperty('acquisitionsManager');
  expect(payload.smsBody).toContain("Maria's assistant");
  expect(mocks.adminFrom).toHaveBeenCalledWith('acquisition_commands');
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
    followUp:{acquisitionsManager:'Maria',policyVersion:1,introId:'mel-maria-assistant-1',introVersion:2,templateId:'no-answer-callback-time',templateVersion:1,
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
    followUp:{acquisitionsManager:'Maria',policyVersion:1,introId:'mel-maria-assistant-1',introVersion:2,templateId:'no-answer-callback-time',templateVersion:1,
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
    followUp:{acquisitionsManager:'Maria',policyVersion:1,introId:'mel-maria-assistant-1',introVersion:2,templateId:'no-answer-callback-time',templateVersion:1,
      initialRemainder:"Maria wasn't able to reach you. What time would work for her to call you back?",
      remainder:"Maria wasn't able to reach you. What time would work for her to call you back?",body:'ignored'},
  });
  expect(result).toEqual({ok:true,attemptRecorded:true,followUp:{status:'delivery_failed',message:'carrier rejected'}});
});

describe('savePostCallExtras',()=>{
  const SUB='11111111-1111-4111-8111-111111111111';
  const KEY='33333333-3333-4333-8333-333333333333';
  const CALL='22222222-2222-4222-8222-222222222222';
  const NOTE_KEY='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const STEP_KEY='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const DUE='2026-10-06T15:00:00.000Z';
  const input=(over:Record<string,unknown>={})=>({memberId:'actor',propertyId:'lead',submissionId:SUB,attemptKey:KEY,callActivityId:CALL,note:'Left a message',nextStep:{pick:'tomorrow' as const,dueAt:DUE},...over});
  const proven={data:{status:'proven',attemptId:'attempt-1',noteKey:NOTE_KEY,nextStepKey:STEP_KEY},error:null};
  const noWrites=()=>{expect(mocks.createNote).not.toHaveBeenCalled();expect(mocks.createStep).not.toHaveBeenCalled();};
  beforeEach(()=>{
    mocks.queueRow.mockResolvedValue({status:'found',row:{contactId:'contact-1',address:'1 Main St'},snapshotAt:'x'});
    mocks.ready.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue(proven);
    mocks.createNote.mockResolvedValue({ok:true,data:{id:'note-1'}});
    mocks.createStep.mockResolvedValue({ok:true,data:{taskId:'task-1'}});
  });
  it('rejects a lead that is not in the member queue before any write',async()=>{
    mocks.queueRow.mockResolvedValue({status:'unavailable',reason:'other_rep'});
    expect(await savePostCallExtras(input())).toEqual({ok:false,message:'This lead is no longer in your queue.'});
    noWrites();
  });
  it('rejects an unreadable lead, a missing attempt key and malformed input before any write',async()=>{
    mocks.queueRow.mockRejectedValue(new Error('FORBIDDEN'));
    expect((await savePostCallExtras(input())).ok).toBe(false);
    mocks.queueRow.mockResolvedValue({status:'found',row:{contactId:'contact-1',address:'1 Main St'},snapshotAt:'x'});
    expect((await savePostCallExtras(input({submissionId:'nope'}))).ok).toBe(false);
    expect((await savePostCallExtras(input({attemptKey:undefined}))).ok).toBe(false);
    expect((await savePostCallExtras(input({attemptKey:'nope'}))).ok).toBe(false);
    expect((await savePostCallExtras(input({nextStep:{pick:'someday',dueAt:DUE}}))).ok).toBe(false);
    expect((await savePostCallExtras(input({nextStep:{pick:'custom',dueAt:'garbage'}}))).ok).toBe(false);
    expect(mocks.rpc).not.toHaveBeenCalled();noWrites();
  });
  it('asks the database to prove the attempt first, with the actor org, lead, attempt key and call',async()=>{
    await savePostCallExtras(input());
    expect(mocks.rpc).toHaveBeenCalledWith('fn_post_call_extras_proof',{p_org:'actual-org',p_property:'lead',p_attempt_key:KEY,p_call_activity:CALL});
  });
  it('proven: the note and the appointment use the keys the PROOF returned, never the client submission id (matrix 1, 10, 11)',async()=>{
    expect(await savePostCallExtras(input())).toEqual({ok:true,note:'saved',nextStep:'created'});
    expect(mocks.createNote).toHaveBeenCalledWith('lead','Left a message',NOTE_KEY);
    expect(mocks.createStep).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:STEP_KEY,kind:'appointment',mode:'phone',assigneeId:'actor',origin:'app'}));
    // A second opening (different submission id) lands on the same derived keys.
    await savePostCallExtras(input({submissionId:'44444444-4444-4444-8444-444444444444'}));
    expect(mocks.createNote.mock.calls[1][2]).toBe(NOTE_KEY);expect(mocks.createStep.mock.calls[1][0].idempotencyKey).toBe(STEP_KEY);
    expect(mocks.createStep.mock.calls[0][0]).not.toHaveProperty('applyBookingEffects');
  });
  it("accepts the real derived keys SQL returns for Astra's literal attempt id (version 5, RFC variant) and writes both extras",async()=>{
    // fn_post_call_derived_uuid('post_call_note:' || attempt) / ('post_call_next_step:' || attempt) for 11111111-1111-4111-8111-111111111111 (asserted in the integration test).
    const note='249bbca2-5080-5e49-a611-69fe513eab4f',step='fcecf655-7a01-5c38-b419-fc6a43c4a1c2';
    mocks.rpc.mockResolvedValue({data:{status:'proven',attemptId:'11111111-1111-4111-8111-111111111111',noteKey:note,nextStepKey:step},error:null});
    expect(await savePostCallExtras(input())).toEqual({ok:true,note:'saved',nextStep:'created'});
    expect(mocks.createNote).toHaveBeenCalledWith('lead','Left a message',note);
    expect(mocks.createStep).toHaveBeenCalledWith(expect.objectContaining({idempotencyKey:step}));
  });
  it('rejects the old raw-md5 keys (no version/variant bits) instead of writing under them',async()=>{
    mocks.rpc.mockResolvedValue({data:{status:'proven',noteKey:'249bbca2-5080-4e49-2611-69fe513eab4f',nextStepKey:'fcecf655-7a01-bc38-b419-fc6a43c4a1c2'},error:null});
    expect(await savePostCallExtras(input())).toMatchObject({ok:false,pending:true});noWrites();
  });
  it('pending (no receipt for this key): writes nothing and keeps the extras for Retry (matrix 5, 7, 8)',async()=>{
    mocks.rpc.mockResolvedValue({data:{status:'pending'},error:null});
    expect(await savePostCallExtras(input())).toEqual({ok:false,pending:true,message:"Not saved yet: this call's save isn't confirmed. Your note is kept."});
    noWrites();
  });
  it('foreign (another key finalized the call): writes nothing and tells the caller to drop the extras (matrix 5, 9)',async()=>{
    mocks.rpc.mockResolvedValue({data:{status:'foreign'},error:null});
    expect(await savePostCallExtras(input())).toEqual({ok:false,message:'This was already saved. Refresh to see it.',alreadySaved:true});
    noWrites();
  });
  it('fails closed, keeping the extras, when the proof function is not installed yet (matrix 16)',async()=>{
    mocks.ready.mockImplementation(async(feature:string)=>feature!=='post_call_extras_proof');
    const result=await savePostCallExtras(input());
    expect(result).toMatchObject({ok:false,pending:true});expect(mocks.rpc).not.toHaveBeenCalled();noWrites();
  });
  it.each([
    ['an rpc error',{data:null,error:{message:'boom'}}],
    ['no answer',{data:null,error:null}],
    ['an unknown status',{data:{status:'maybe'},error:null}],
    ['proven without keys',{data:{status:'proven'},error:null}],
  ])('fails closed, keeping the extras, on %s (matrix 17)',async(_name,answer)=>{
    mocks.rpc.mockResolvedValue(answer);
    expect(await savePostCallExtras(input())).toMatchObject({ok:false,pending:true});noWrites();
  });
  it('fails closed when the proof call throws',async()=>{
    mocks.rpc.mockRejectedValue(new Error('network'));
    expect(await savePostCallExtras(input())).toMatchObject({ok:false,pending:true});noWrites();
  });
  it('note only: writes the note under the proven key and no step',async()=>{
    expect(await savePostCallExtras(input({nextStep:null}))).toEqual({ok:true,note:'saved',nextStep:'skipped'});
    expect(mocks.createNote).toHaveBeenCalledWith('lead','Left a message',NOTE_KEY);
    expect(mocks.createStep).not.toHaveBeenCalled();
  });
  it('pick only: creates a phone appointment for the rep with booking effects off and no note',async()=>{
    expect(await savePostCallExtras(input({note:'  '}))).toEqual({ok:true,note:'skipped',nextStep:'created'});
    expect(mocks.createNote).not.toHaveBeenCalled();
    expect(mocks.createStep).toHaveBeenCalledWith({kind:'appointment',mode:'phone',propertyId:'lead',contactId:'contact-1',assigneeId:'actor',dueAt:DUE,title:'Call 1 Main St',idempotencyKey:STEP_KEY,origin:'app'});
  });
  it('a manual attempt (no call id) is still proven by its key alone',async()=>{
    await savePostCallExtras(input({callActivityId:null}));
    expect(mocks.rpc).toHaveBeenCalledWith('fn_post_call_extras_proof',expect.objectContaining({p_call_activity:null}));
    expect(mocks.createNote).toHaveBeenCalledWith('lead','Left a message',NOTE_KEY);
  });
  it('a note failure still creates the step and says what failed',async()=>{
    mocks.createNote.mockResolvedValue({ok:false,error:{code:'NOTE_CREATE_FAILED',message:'boom'}});
    expect(await savePostCallExtras(input())).toEqual({ok:true,note:'failed',nextStep:'created',message:'Note not saved: boom'});
    expect(mocks.createStep).toHaveBeenCalledTimes(1);
  });
  it('a step failure keeps the saved note',async()=>{
    mocks.createStep.mockResolvedValue({ok:false,error:{code:'TIME_INVALID',message:'bad time'}});
    expect(await savePostCallExtras(input())).toEqual({ok:true,note:'saved',nextStep:'failed',message:'Next step not set: bad time'});
  });
  it('the same attempt returns the existing ids and succeeds again',async()=>{
    mocks.createStep.mockResolvedValue({ok:true,data:{taskId:'task-1',duplicate:true}});
    expect(await savePostCallExtras(input())).toEqual({ok:true,note:'saved',nextStep:'created'});
    expect(await savePostCallExtras(input())).toEqual({ok:true,note:'saved',nextStep:'created'});
    expect(mocks.createNote.mock.calls[1][2]).toBe(NOTE_KEY);
  });
  it('an appointment that already exists for the attempt with different details counts as created, not a failure to retry (matrix 18)',async()=>{
    mocks.createStep.mockResolvedValue({ok:false,error:{code:'CREATE_NEXT_STEP_FAILED',message:'fn_create_next_step: idempotency key reuse with different request'}});
    expect(await savePostCallExtras(input())).toEqual({ok:true,note:'saved',nextStep:'created'});
  });
  it('before the note or step migration: that extra is skipped and said so, nothing throws',async()=>{
    mocks.ready.mockImplementation(async(feature:string)=>feature==='post_call_extras_proof');
    const result=await savePostCallExtras(input());
    expect(result).toMatchObject({ok:true,note:'skipped',nextStep:'skipped'});
    noWrites();
  });
});
describe('loadMyLeadCallReferences',()=>{
  it('maps the call facts and tolerates their absence before the migration',async()=>{
    mocks.rpc.mockResolvedValue({data:[
      {id:'a',occurredAt:'2026-10-05T15:00:00Z',callOutcome:'voicemail',talkSeconds:3,provider:'dialpad'},
      {id:'b',occurredAt:'2026-10-05T16:00:00Z'},
    ],error:null});
    const result=await loadMyLeadCallReferences('lead','actor');
    expect(result).toMatchObject({ok:true,options:[
      {id:'a',callOutcome:'voicemail',talkSeconds:3,provider:'dialpad'},
      {id:'b',callOutcome:null,talkSeconds:null,provider:null},
    ]});
  });
});
