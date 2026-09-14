'use server';
import {randomUUID} from 'node:crypto';
import {getAcquisitionRoster} from '@/lib/my-leads/queries';
import {bindAcquisitionCallContext} from '@/lib/my-leads/call-binding';
import {inspectLeadCall} from '@/lib/dialer/actions';
import {createDialpadVoiceAdminClient} from './database';
import type {ConfiguredStartDatabase} from './configured-start-database';
import {DialpadVoiceClient,DialpadVoiceError} from './client';
import {verifyDialpadInventory} from './verified-inventory';
import {verifySelectedDialpadDesktop} from './desktop-device';
const uuid=(x:unknown):x is string=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
type Input={propertyId:string;grantId:string;bindingRevision:number;grantRevision:number;connectionVersion:number;deviceId:string;idempotencyKey:string};
type Result={ok:true;intentId:string;status:string}|{ok:false;error:string};
/** Unmounted and disabled. Native registration does not prove media readiness.
 * Session actor and stored exact grant own all provider identity; no automatic retry. */
export async function startConfiguredDialpadCall(input:Input):Promise<Result>{
 if(process.env.DIALPAD_CONFIGURED_START_ENABLED!=='true')return{ok:false,error:'disabled'};
 if(!input||![input.propertyId,input.grantId,input.idempotencyKey].every(uuid)||typeof input.deviceId!=='string'||!input.deviceId.trim()||input.deviceId.length>512||/[\r\n]/.test(input.deviceId)
 ||![input.bindingRevision,input.grantRevision,input.connectionVersion].every(n=>Number.isSafeInteger(n)&&n>0))return{ok:false,error:'invalid_input'};
 try{
  const {viewer,roster}=await getAcquisitionRoster();
  if(!roster.settings.enabled||!roster.members.some(m=>m.id===viewer.userId&&m.active&&m.acquisitionsEnabled))return{ok:false,error:'forbidden'};
  const db=createDialpadVoiceAdminClient<ConfiguredStartDatabase>();
  const old=await db.from('dialpad_voice_intents').select('id,property_id,status').eq('org_id',viewer.orgId).eq('actor_user_id',viewer.userId).eq('client_idempotency_key',input.idempotencyKey).maybeSingle();
  if(old.error)return{ok:false,error:'intent_read_failed'};
  // A replay never dispatches, even when a prior request stopped before HTTP.
  if(old.data)return old.data.property_id===input.propertyId?{ok:true,intentId:old.data.id,status:old.data.status}:{ok:false,error:'idempotency_conflict'};
  const connection=await db.from('dialpad_org_connections').select('*').eq('org_id',viewer.orgId).maybeSingle();const c=connection.data;
  if(connection.error||!c||c.org_id!==viewer.orgId||!c.enabled||!c.verified_at||c.config_version!==input.connectionVersion||!/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(c.credential_reference))return{ok:false,error:'configuration_unavailable'};
  const binding=await db.from('dialpad_member_bindings').select('*').eq('org_id',viewer.orgId).eq('member_user_id',viewer.userId).is('revoked_at',null).maybeSingle();const b=binding.data;
  if(binding.error||!b||b.org_id!==viewer.orgId||b.member_user_id!==viewer.userId||b.revoked_at!==null||b.connection_id!==c.id||b.connection_version!==c.config_version||b.revision!==input.bindingRevision)return{ok:false,error:'binding_unavailable'};
  const grant=await db.from('dialpad_number_grants').select('*').eq('org_id',viewer.orgId).eq('binding_id',b.id).eq('id',input.grantId).is('revoked_at',null).maybeSingle();const g=grant.data;
  if(grant.error||!g||g.org_id!==viewer.orgId||g.binding_id!==b.id||g.revoked_at!==null||g.revision!==input.grantRevision)return{ok:false,error:'grant_unavailable'};
  const member=await db.auth.admin.getUserById(viewer.userId);const email=member.data.user?.email;
  if(member.error||!email||member.data.user?.id!==viewer.userId)return{ok:false,error:'member_unavailable'};
  const provider=new DialpadVoiceClient(process.env[c.credential_reference.slice(4)]??'');
  const inventory=await verifyDialpadInventory(provider,{orgId:viewer.orgId,providerCompanyId:c.provider_company_id,providerUserId:b.provider_user_id,memberEmail:email});
  if(!inventory.inventory.callers.some(n=>n.number===g.number_e164&&n.identity.type===g.identity_type&&n.identity.id===g.provider_identity_id))return{ok:false,error:'grant_not_verified'};
  await verifySelectedDialpadDesktop(provider,{providerUserId:b.provider_user_id,deviceId:input.deviceId});const deviceVerifiedAt=new Date().toISOString();
  const eligible=await inspectLeadCall(input.propertyId);
  if(!eligible.ok||eligible.data.propertyId!==input.propertyId)return{ok:false,error:'lead_not_callable'};
  const verified=await db.from('dialpad_inventory_verifications').insert({org_id:viewer.orgId,connection_id:c.id,connection_version:c.config_version,provider_company_id:c.provider_company_id,member_user_id:viewer.userId,provider_user_id:b.provider_user_id,member_email_matched:true,verified_at:inventory.provenance.verifiedAt,callers:inventory.inventory.callers.map(n=>({identity_type:n.identity.type,provider_identity_id:n.identity.id,number_e164:n.number}))}).select('id').single();
  if(verified.error||!verified.data)return{ok:false,error:'verification_unavailable'};
  const intentId=randomUUID();const bound=await bindAcquisitionCallContext({orgId:viewer.orgId,propertyId:input.propertyId,actorUserId:viewer.userId,callToken:intentId});
  if(!bound.tracked)return{ok:false,error:'binding_required'};
  const prep=await db.rpc('fn_prepare_dialpad_configured_intent',{p_org_id:viewer.orgId,p_actor_id:viewer.userId,p_property_id:input.propertyId,p_intent_id:intentId,p_idempotency_key:input.idempotencyKey,p_grant_id:g.id,p_verification_id:verified.data.id,p_device_id:input.deviceId,p_device_verified_at:deviceVerifiedAt,p_destination_e164:eligible.data.phoneE164});
  if(prep.error||!object(prep.data)||prep.data.intentId!==intentId)return{ok:false,error:'prepare_unconfirmed'};
  let dispatchClaimAttempted=false;
  const release=async(status?:number)=>{const r=await db.rpc('fn_release_dialpad_start',{p_intent_id:intentId,...(status===undefined?{}:{p_rejection_http_status:status})});return !r.error&&object(r.data)&&r.data.released===true;};
  try{
   const pause=await db.rpc('fn_prepare_dialpad_sequence_pause',{p_intent_id:intentId});if(pause.error||!object(pause.data)||typeof pause.data.paused!=='number')throw Error('pause_failed');
   const recheck=await inspectLeadCall(input.propertyId);if(!recheck.ok||recheck.data.propertyId!==input.propertyId||recheck.data.phoneE164!==eligible.data.phoneE164)throw Error('eligibility_changed');
   dispatchClaimAttempted=true;
   const claim=await db.rpc('fn_dispatch_configured_dialpad_intent',{p_org_id:viewer.orgId,p_actor_id:viewer.userId,p_intent_id:intentId});const d=claim.data;
   // These PostgreSQL errors prove the statement rejected the claim. Scoped
   // release still checks durable dispatch state; transport errors stay unknown.
   if(claim.error&&['42501','23514','22023'].includes(claim.error.code)){
    return{ok:true,intentId,status:await release()?'failed':'initiation_unconfirmed'};
   }
   if(claim.error||!object(d)||d.dispatched!==true)return{ok:true,intentId,status:'initiation_unconfirmed'};
   if(d.intentId!==intentId||d.connectionId!==c.id||d.connectionVersion!==c.config_version||d.credentialReference!==c.credential_reference||d.providerCompanyId!==c.provider_company_id||d.providerUserId!==b.provider_user_id||d.deviceId!==input.deviceId||d.phoneNumber!==eligible.data.phoneE164||d.outboundCallerId!==g.number_e164||d.identityType!==g.identity_type||d.identityId!==g.provider_identity_id||d.customData!==intentId)throw Error('claim_mismatch');
   const group=g.identity_type==='user'?undefined:{id:g.provider_identity_id,type:g.identity_type as 'office'|'department'|'callcenter'};
   try{const response=await provider.initiateSelectedDeviceCall({userId:b.provider_user_id,deviceId:input.deviceId,phoneNumber:eligible.data.phoneE164,outboundCallerId:g.number_e164,customData:intentId,...(group?{group}:{})});
    // Capture only a provider response candidate; signed evidence still owns credit.
    if(typeof response.call_id!=='string'||!/^[1-9]\d{0,39}$/.test(response.call_id))throw Error('response_invalid');
    const receipt=await db.rpc('fn_record_dialpad_dispatch_response',{p_org_id:viewer.orgId,p_actor_id:viewer.userId,p_intent_id:intentId,p_candidate_call_id:response.call_id});
    if(receipt.error||!object(receipt.data)||receipt.data.recorded!==true)throw Error('response_receipt_unconfirmed');
   }
   catch(e){if(e instanceof DialpadVoiceError&&e.code==='http'&&[400,401,403,404,422].includes(e.status??0)){return{ok:true,intentId,status:await release(e.status)?'failed':'initiation_unconfirmed'};}}
   return{ok:true,intentId,status:'initiation_unconfirmed'};
  }catch{if(!dispatchClaimAttempted){try{if(await release())return{ok:true,intentId,status:'failed'};}catch{}}
   return{ok:true,intentId,status:dispatchClaimAttempted?'initiation_unconfirmed':'prepared'};}
 }catch{return{ok:false,error:'configured_start_unavailable'};}
}
