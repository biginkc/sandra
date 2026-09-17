'use server';
import { revalidatePath } from 'next/cache';
import { reportError } from '@/lib/errors/report';
import type { Json } from '@/lib/supabase/types';
import { createAdminClient } from '@/lib/supabase/admin';
import { composeRepSms, type RepSmsComposition, type RepSmsCompositionInput } from '@/lib/messaging/rep-sms-composition';
import { dispatchRepSms } from '@/lib/messaging/rep-sms';
import { getAcquisitionQueue,getAcquisitionKpis,getAcquisitionDetail,myLeadsViewer,type DetailGroup } from '@/lib/my-leads/queries';
import { setAcquisitionDesignation,setAcquisitionSettings } from '@/lib/my-leads/settings';
import type { SetAcquisitionDesignationInput,SetAcquisitionSettingsInput } from '@/lib/my-leads/types';
import type { QueueStage } from '@/lib/my-leads/types';

export async function loadMyLeads(input:{memberId:string;search:string;period:'today'|'week'|'month'|'custom';startDate?:string;endDate?:string}) {
  try {
    const [snapshot,kpis]=await Promise.all([getAcquisitionQueue(input),getAcquisitionKpis({memberId:input.memberId,period:'today'})]);
    return {ok:true as const,snapshot,kpis};
  } catch(error) {reportMyLeadsReadFailure('my_leads_queue');return {ok:false as const,message:error instanceof Error?error.message:'Could not load My Leads.'};}
}
export async function loadMyLeadsStage(input:{memberId:string;search:string;stage:QueueStage;cursor:string}) {
  try {return {ok:true as const,snapshot:await getAcquisitionQueue(input)};}
  catch(error){reportMyLeadsReadFailure('my_leads_stage');return {ok:false as const,message:error instanceof Error?error.message:'Could not load this section.'};}
}
export async function loadMyLeadDetail(input:{memberId:string;propertyId:string;group?:DetailGroup;cursor?:string|null}) {
  try {return {ok:true as const,detail:await getAcquisitionDetail(input)};}
  catch(error){reportMyLeadsReadFailure('my_leads_detail');return {ok:false as const,message:error instanceof Error?error.message:'Could not load lead details.'};}
}
function reportMyLeadsReadFailure(operation:string) {
  const diagnostic=new Error('My Leads read failed');
  diagnostic.name='MyLeadsReadFailure';
  reportError(diagnostic,{errorClass:'database',tags:{surface:'server',operation,kind:'read_failure'}});
}
const commands={
  'log-attempt':'fn_log_acquisition_attempt','ready-for-offer':'fn_ready_acquisition_offer','log-offer':'fn_log_acquisition_offer',
  'contract-signed':'fn_record_acquisition_contract','decline-offer':'fn_decline_acquisition_offer','handoff':'fn_handoff_acquisition_lead','archive':'fn_archive_acquisition_contract',
} as const;
export async function submitMyLeadCommand(command:keyof typeof commands,input:Record<string,Json>) {
  if(!Object.hasOwn(commands,command)) return {ok:false as const,message:'Unsupported action.'};
  let viewer;
  try { viewer=await myLeadsViewer(); }
  catch { return {ok:false as const,message:'Sign in with an active organization before updating a lead.'}; }
  const client=viewer.client;
  input={...input,orgId:viewer.orgId};
  let composition: RepSmsComposition | null = null;
  if (command === 'log-attempt' && input.outcome === 'no_answer') {
    try {
      const supplied = input.followUp && typeof input.followUp === 'object' && !Array.isArray(input.followUp)
        ? input.followUp as RepSmsCompositionInput
        : { body: typeof input.smsBody === 'string' ? input.smsBody : null };
      // The no-answer path requires curated copy. This check runs before the
      // attempt RPC, so malformed or unapproved copy can never create work.
      if (!supplied.templateId) throw new Error('Choose a curated follow-up template.');
      composition = composeRepSms(supplied);
      input = {
        ...input,
        smsBody: composition.finalBody,
        followUp: {
          ...composition,
          body: composition.finalBody,
        } as unknown as Json,
      };
    } catch (error) {
      return {ok:false as const,message:error instanceof Error?error.message:'Choose a valid follow-up message.'};
    }
  }
  const {data,error}=await (client as unknown as {rpc(name:string,args:{p_input:Json}):Promise<{data:Json|null;error:{message?:string}|null}>}).rpc(command==='log-attempt'&&input.source==='sandra'?'fn_finalize_acquisition_attempt':commands[command],{p_input:input});
  if(error) {
    const message=error.message??'';
    if(message==='FORBIDDEN') return {ok:false as const,code:'FORBIDDEN' as const,message:'This lead is unavailable or you no longer have access. Refresh to check access. Your draft is retained.'};
    if(message.includes('STALE_')) return {ok:false as const,code:'STALE_STATE' as const,message:'This lead changed. Refresh before trying again.'};
    return {ok:false as const,message:message.includes('MOTIVATION')?'Specify motivation or choose No motivation provided.':message.includes('PENDING_OFFER')?'Resolve the current pending offer first.':message.includes('RECIPIENT')?'The handoff recipient is unavailable. Ask the owner to update settings.':'The update could not be saved. Check the fields and retry.'};
  }
  if(!data||typeof data!=='object'||Array.isArray(data)||data.ok!==true) return {ok:false as const,message:'The update was not confirmed. Retry with the same form.'};
  revalidatePath('/my-leads');revalidatePath('/leads');
  if(typeof input.propertyId==='string') revalidatePath(`/leads/${input.propertyId}`);
  const record = data as Record<string, unknown>;
  if (command === 'log-attempt' && input.outcome === 'no_answer') {
    return finishNoAnswerFollowUp({
      viewer,
      input,
      record,
      composition,
    });
  }
  const followUpValue = record.followUp ?? record.follow_up;
  const followUp = followUpValue && typeof followUpValue === 'object' && !Array.isArray(followUpValue)
    ? followUpValue as { status?: unknown; message?: unknown }
    : null;
  const allowedFollowUpStatuses = new Set(['required','draft','sending','accepted','delivered','delivery_failed','blocked','failed_not_dispatched','unknown']);
  if (followUp && typeof followUp.status === 'string' && allowedFollowUpStatuses.has(followUp.status)) {
    return {
      ok: true as const,
      attemptRecorded: command === 'log-attempt',
      followUp: {
        status: followUp.status as 'required'|'draft'|'sending'|'accepted'|'delivered'|'delivery_failed'|'blocked'|'failed_not_dispatched'|'unknown',
        message: typeof followUp.message === 'string' ? followUp.message : null,
      },
    };
  }
  return {ok:true as const, ...(command === 'log-attempt' ? {attemptRecorded:true as const} : {})};
}

type FollowUpStatus =
  | 'required'
  | 'draft'
  | 'sending'
  | 'accepted'
  | 'delivered'
  | 'delivery_failed'
  | 'blocked'
  | 'failed_not_dispatched'
  | 'unknown';

type ObligationRpc = {
  data: Json | null;
  error: { message?: string; code?: string } | null;
};

function followUpResult(status: FollowUpStatus, message?: string | null) {
  return {
    ok: true as const,
    attemptRecorded: true as const,
    followUp: { status, message: message ?? null },
  };
}

async function finishNoAnswerFollowUp(args: {
  viewer: Awaited<ReturnType<typeof myLeadsViewer>>;
  input: Record<string, Json>;
  record: Record<string, unknown>;
  composition: RepSmsComposition | null;
}) {
  const obligationId = typeof args.record.obligationId === 'string'
    ? args.record.obligationId
    : typeof args.record.obligation_id === 'string'
      ? args.record.obligation_id
      : null;
  if (!obligationId || !args.composition) {
    return followUpResult('blocked', 'Attempt recorded. Follow-up texting is not enabled for this rep.');
  }

  let admin: { rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc> };
  try {
    admin = createAdminClient() as unknown as {
      rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc>;
    };
  } catch {
    return followUpResult('unknown', 'Attempt recorded. Follow-up authorization is unavailable; refresh before retrying.');
  }
  let claim: ObligationRpc;
  try {
    claim = await admin.rpc('fn_claim_authorize_rep_sms_obligation', {
      p_org_id: args.viewer.orgId,
      p_obligation_id: obligationId,
      p_actor_id: args.viewer.userId,
      p_composition: {
        ...args.composition,
        body: args.composition.finalBody,
      },
    });
  } catch {
    return followUpResult('unknown', 'Attempt recorded. Follow-up authorization could not be confirmed. Refresh before retrying.');
  }
  if (claim.error || !claim.data || typeof claim.data !== 'object' || Array.isArray(claim.data)) {
    return followUpResult('unknown', 'Attempt recorded. Follow-up authorization could not be confirmed. Refresh before retrying.');
  }
  const claimRecord = claim.data as Record<string, unknown>;
  const claimState = typeof claimRecord.state === 'string' ? claimRecord.state : null;
  const claimMessage = typeof claimRecord.reason === 'string' ? claimRecord.reason : null;
  if (claimRecord.ok !== true) {
    if (claimState && isFollowUpStatus(claimState)) return followUpResult(claimState, claimMessage);
    return followUpResult('unknown', claimMessage ?? 'Attempt recorded. Follow-up authorization could not be confirmed.');
  }
  if (claimState !== 'sending' || typeof claimRecord.claimToken !== 'string'
    || typeof claimRecord.assignmentId !== 'string' || typeof claimRecord.toNumber !== 'string') {
    return followUpResult('unknown', 'Attempt recorded. Follow-up authorization returned an invalid fence. Refresh before retrying.');
  }

  let dispatchOutcome: Awaited<ReturnType<typeof dispatchRepSms>>;
  try {
    dispatchOutcome = await dispatchRepSms({
      propertyId: String(args.input.propertyId),
      assignmentId: claimRecord.assignmentId,
      to: claimRecord.toNumber,
      composition: args.composition,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Authorization is already durable. An exception cannot prove whether the
    // provider request was reached, so keep the obligation review-only rather
    // than exposing a retry that could send a duplicate SMS.
    return persistFollowUpResult(admin, obligationId, claimRecord.claimToken, 'unknown', reason, args.composition);
  }

  const outcome = dispatchOutcome as Record<string, unknown>;
  const providerId = typeof outcome.externalId === 'string' ? outcome.externalId : null;
  const reason = typeof outcome.error === 'string'
    ? outcome.error
    : typeof outcome.reason === 'string'
      ? outcome.reason
      : `Dispatch returned ${String(outcome.status ?? 'unknown')}.`;
  if (outcome.status === 'sent' || (outcome.status === 'db_error' && providerId)) {
    return persistFollowUpResult(admin, obligationId, claimRecord.claimToken, 'accepted', providerId, args.composition);
  }
  if (typeof outcome.status === 'string' && outcome.status.startsWith('blocked_')) {
    return persistFollowUpResult(admin, obligationId, claimRecord.claimToken, 'blocked', reason, args.composition);
  }
  // Once dispatchRepSms has crossed its provider boundary, a provider failure
  // is ambiguous. Keep it unknown; only an exception before that call can be
  // reported as failed_not_dispatched.
  return persistFollowUpResult(admin, obligationId, claimRecord.claimToken, 'unknown', reason, args.composition);
}

function isFollowUpStatus(value: string): value is FollowUpStatus {
  return ['required','draft','sending','accepted','delivered','delivery_failed','blocked','failed_not_dispatched','unknown'].includes(value);
}

async function persistFollowUpResult(
  admin: { rpc(name: string, input: Record<string, unknown>): Promise<ObligationRpc> },
  obligationId: string,
  claimToken: string,
  state: 'accepted' | 'blocked' | 'failed_not_dispatched' | 'unknown',
  value: string | null,
  composition: RepSmsComposition,
) {
  let result: ObligationRpc;
  try {
    result = await admin.rpc('fn_record_rep_sms_obligation_result', {
      p_obligation_id: obligationId,
      p_claim_token: claimToken,
      p_state: state,
      p_provider_message_id: state === 'accepted' ? value : null,
      p_provider_error: state === 'accepted' ? null : value ?? `Follow-up ${state}.`,
      p_metadata: {
        policyVersion: composition.policyVersion,
        introId: composition.introId,
        introVersion: composition.introVersion,
        templateId: composition.templateId,
        templateVersion: composition.templateVersion,
        initialRemainder: composition.initialRemainder,
        remainder: composition.remainder,
        body: composition.finalBody,
      } as Json,
    });
  } catch {
    return followUpResult('unknown', 'Attempt recorded. Follow-up result could not be persisted; refresh before retrying.');
  }
  if (result.error || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)
    || (result.data as Record<string, unknown>).ok !== true) {
    return followUpResult('unknown', 'Attempt recorded. Follow-up result could not be persisted; refresh before retrying.');
  }
  return followUpResult(state, state === 'accepted' ? null : value);
}

export async function changeAcquisitionDesignation(input:SetAcquisitionDesignationInput) {
  const result=await setAcquisitionDesignation(input);if(result.ok) revalidatePath('/my-leads');return result;
}
export async function changeAcquisitionSettings(input:SetAcquisitionSettingsInput) {
  const result=await setAcquisitionSettings(input);if(result.ok) revalidatePath('/my-leads');return result;
}

export async function loadMyLeadCallReferences(propertyId:string,memberId:string) {
  try {
    const viewer=await myLeadsViewer();
    const {data,error}=await (viewer.client as unknown as {rpc(name:string,args:Record<string,string>):Promise<{data:{id:string;occurredAt:string}[]|null;error:unknown}>}).rpc('fn_get_acquisition_call_references',{p_org_id:viewer.orgId,p_property_id:propertyId,p_member_id:memberId});
    if(error||!data)return {ok:false as const,message:'Could not load pending call references.'};
    return {ok:true as const,options:data.map(call=>({id:call.id,label:new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:'America/Chicago'}).format(new Date(call.occurredAt))+' Central'}))};
  }catch{return {ok:false as const,message:'Could not load pending call references.'};}
}
