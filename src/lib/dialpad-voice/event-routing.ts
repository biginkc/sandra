import 'server-only';
import type {SupabaseClient} from '@supabase/supabase-js';
import type {EventConfigurationDatabase} from './event-configuration-database';
import {DialpadEvidenceRejected,type ClaimedVoiceEvent} from './event-worker';
import type {DialpadCallEvent} from './call-event';
/** Signed receipt source and frozen intent must name the same provider company.
 * No current membership, current connection, candidate ID, or payload tenant. */
export async function resolveConfiguredEventRoute(db:SupabaseClient<EventConfigurationDatabase>,receipt:ClaimedVoiceEvent,event:DialpadCallEvent){
 if(!receipt.webhookSourceId||event.direction!=='outbound'||event.targetType?.toLowerCase()!=='user')throw new DialpadEvidenceRejected();
 const source=await db.from('dialpad_voice_webhook_sources').select('*').eq('org_id',receipt.orgId).eq('id',receipt.webhookSourceId).maybeSingle();const s=source.data;
 if(source.error)throw Error('source unavailable');if(!s||s.org_id!==receipt.orgId||s.id!==receipt.webhookSourceId)throw new DialpadEvidenceRejected();
 let q=db.from('dialpad_voice_intents').select('*').eq('org_id',receipt.orgId);
 q=event.intentId?q.eq('id',event.intentId):q.eq('provider_call_id',event.callId);
 const result=await q.maybeSingle();const i=result.data;
 if(result.error)throw Error('intent unavailable');
 if(!i||i.org_id!==receipt.orgId||i.dialpad_user_id!==event.targetId||(event.intentId&&i.id!==event.intentId)||(i.provider_call_id!==null&&i.provider_call_id!==event.callId)||(!event.intentId&&i.provider_call_id!==event.callId))throw new DialpadEvidenceRejected();
 const config=await db.from('dialpad_intent_configuration').select('*').eq('org_id',receipt.orgId).eq('intent_id',i.id).maybeSingle();const c=config.data;
 if(config.error)throw Error('configuration unavailable');if(!c||c.org_id!==receipt.orgId||c.intent_id!==i.id)throw new DialpadEvidenceRejected();
 const revision=async(connection:string,version:number)=>{const r=await db.from('dialpad_connection_revisions').select('*').eq('org_id',receipt.orgId).eq('connection_id',connection).eq('config_version',version).maybeSingle();if(r.error)throw Error('history unavailable');if(!r.data||r.data.org_id!==receipt.orgId||r.data.connection_id!==connection||r.data.config_version!==version)throw new DialpadEvidenceRejected();return r.data;};
 const [from,to]=await Promise.all([revision(s.connection_id,s.connection_version),revision(c.connection_id,c.connection_version)]);
 if(from.provider_company_id!==to.provider_company_id||!/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(to.credential_reference))throw new DialpadEvidenceRejected();
 return{intentId:i.id,providerUserId:i.dialpad_user_id,providerCompanyId:to.provider_company_id,credentialReference:to.credential_reference};
}
