'use server';
import {getAcquisitionRoster} from '@/lib/my-leads/queries';
import {createDialpadVoiceAdminClient} from './database';
import type {DialpadVoiceDatabase} from './database.generated';
import {DialpadVoiceClient} from './client';
import {resolveHistoricalDialpadConnection} from './historical-connection';
type Table<Row>={Row:Row;Insert:never;Update:never;Relationships:[]};
type DB=Omit<DialpadVoiceDatabase,'public'>&{public:Omit<DialpadVoiceDatabase['public'],'Tables'>&{Tables:DialpadVoiceDatabase['public']['Tables']&{
 dialpad_intent_configuration:Table<{org_id:string;intent_id:string;connection_id:string;connection_version:number}>;
 dialpad_connection_revisions:Table<{org_id:string;connection_id:string;config_version:number;provider_company_id:string;credential_reference:string}>;
}}};
/** A response candidate alone never authorizes hangup. HTTP success is not terminal evidence. */
export async function hangupConfiguredDialpadCall(input:{intentId:string}){
 if(process.env.DIALPAD_VOICE_HANGUP_ENABLED!=='true')return{ok:false,error:'dialpad_hangup_disabled'} as const;
 if(!input||typeof input.intentId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.intentId))return{ok:false,error:'invalid_input'} as const;
 try{
  const {viewer,roster}=await getAcquisitionRoster();
  if(!roster.members.some(m=>m.id===viewer.userId&&m.active))return{ok:false,error:'forbidden'} as const;
  const db=createDialpadVoiceAdminClient<DB>();
  const result=await db.from('dialpad_voice_intents').select('id,org_id,actor_user_id,dialpad_user_id,property_id,provider_call_id').eq('org_id',viewer.orgId).eq('actor_user_id',viewer.userId).eq('id',input.intentId).maybeSingle();const intent=result.data;
  if(result.error||!intent||intent.id!==input.intentId||intent.org_id!==viewer.orgId||intent.actor_user_id!==viewer.userId||!intent.provider_call_id||!/^[1-9]\d{0,39}$/.test(intent.provider_call_id))return{ok:false,error:'bound_call_required'} as const;
  const activity=await db.from('call_activities').select('org_id,operator_user_id,property_id,provider,provider_call_id,provider_ended_at').eq('org_id',viewer.orgId).eq('operator_user_id',viewer.userId).eq('property_id',intent.property_id).eq('provider','dialpad').eq('provider_call_id',intent.provider_call_id).maybeSingle();const a=activity.data;
  if(activity.error||!a||a.org_id!==viewer.orgId||a.operator_user_id!==viewer.userId||a.property_id!==intent.property_id||a.provider!=='dialpad'||a.provider_call_id!==intent.provider_call_id)return{ok:false,error:'bound_call_required'} as const;
  if(a.provider_ended_at)return{ok:true,status:'already_ended'} as const;
  const route=await resolveHistoricalDialpadConnection({
   readIntent:async()=>intent,
   readConfiguration:async(orgId,intentId)=>{const r=await db.from('dialpad_intent_configuration').select('*').eq('org_id',orgId).eq('intent_id',intentId).maybeSingle();if(r.error)throw Error('history');return r.data;},
   readRevision:async(orgId,connectionId,version)=>{const r=await db.from('dialpad_connection_revisions').select('*').eq('org_id',orgId).eq('connection_id',connectionId).eq('config_version',version).maybeSingle();if(r.error)throw Error('history');return r.data;},
  },{resolve:async ref=>process.env[ref.slice(4)],getCompany:async key=>new DialpadVoiceClient(key).getCompany()},{orgId:viewer.orgId,intentId:input.intentId});
  if(route.actorUserId!==viewer.userId||route.providerUserId!==intent.dialpad_user_id)return{ok:false,error:'bound_call_required'} as const;
  try{await new DialpadVoiceClient(route.apiKey).hangupCall(intent.provider_call_id);return{ok:true,status:'hangup_requested'} as const;}
  catch{return{ok:true,status:'hangup_unconfirmed'} as const;}
 }catch{return{ok:false,error:'dialpad_hangup_failed'} as const;}
}
