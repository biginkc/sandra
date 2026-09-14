import 'server-only';
import {createDialpadVoiceAdminClient} from './database';
import type {EventConfigurationDatabase} from './event-configuration-database';
/** A deployment selects an immutable source, never a company from the payload. */
export async function loadDialpadWebhookSource(sourceId:string){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sourceId))throw Error('source unavailable');
 const db=createDialpadVoiceAdminClient<EventConfigurationDatabase>();
 const r=await db.from('dialpad_voice_webhook_sources').select('*').eq('id',sourceId).maybeSingle();const s=r.data;
 if(r.error||!s||s.id!==sourceId||!/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(s.webhook_secret_reference))throw Error('source unavailable');
 const h=await db.from('dialpad_connection_revisions').select('*').eq('org_id',s.org_id).eq('connection_id',s.connection_id).eq('config_version',s.connection_version).maybeSingle();const c=h.data;
 if(h.error||!c||c.org_id!==s.org_id||c.connection_id!==s.connection_id||c.config_version!==s.connection_version||!/^[1-9]\d{0,39}$/.test(c.provider_company_id))throw Error('source unavailable');
 const secret=process.env[s.webhook_secret_reference.slice(4)];if(!secret?.trim())throw Error('source unavailable');
 return{sourceId:s.id,orgId:s.org_id,secret};
}
