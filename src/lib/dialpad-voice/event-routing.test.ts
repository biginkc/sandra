import {createClient} from '@supabase/supabase-js';
import {expect,it} from 'vitest';
import {resolveConfiguredEventRoute} from './event-routing';
import type {EventConfigurationDatabase} from './event-configuration-database';
import {normalizeDialpadCallEvent} from './call-event';
const org='11111111-1111-4111-8111-111111111111';
function fixture(user='201',patch:Record<string,unknown>={}){
 const requests:URL[]=[];
 const rows:Record<string,unknown>={dialpad_voice_webhook_sources:{id:'source',org_id:org,connection_id:'old',connection_version:1},dialpad_voice_intents:{id:org,org_id:org,actor_user_id:org,dialpad_user_id:user,provider_call_id:'123'},dialpad_intent_configuration:{org_id:org,intent_id:org,connection_id:'old',connection_version:1},dialpad_connection_revisions:{org_id:org,connection_id:'old',config_version:1,provider_company_id:'501',credential_reference:'env:DIALPAD_RETAINED'},...patch};
 const db=createClient<EventConfigurationDatabase>('https://example.test','fixture',{auth:{persistSession:false},global:{fetch:async(input)=>{const url=new URL(String(input));requests.push(url);const table=url.pathname.split('/').at(-1)!;const key=table==='dialpad_connection_revisions'&&url.searchParams.get('connection_id')==='eq.foreign'?'foreign_revision':table;return Response.json(rows[key]??null);}}});
 const receipt={id:'receipt',orgId:org,webhookSourceId:'source',leaseToken:'lease',attemptCount:1,payload:{}};
 const event=normalizeDialpadCallEvent({call_id:'123',state:'hangup',event_timestamp:1700000000000,target:{id:user,type:'user'},direction:'outbound',custom_data:org});
 return{run:()=>resolveConfiguredEventRoute(db,receipt,event),requests,event,receipt};
}
it.each(['201','202'])('routes configured rep %s using frozen history without current-grant reads',async user=>{const f=fixture(user);expect(await f.run()).toMatchObject({providerUserId:user,credentialReference:'env:DIALPAD_RETAINED'});expect(f.requests.every(u=>!u.pathname.includes('member_bindings')&&!u.pathname.includes('org_connections'))).toBe(true);expect(f.requests.every(u=>u.searchParams.get('org_id')===`eq.${org}`)).toBe(true);});
it('rejects cross-tenant intent',async()=>{const f=fixture('201',{dialpad_voice_intents:{id:org,org_id:'other',dialpad_user_id:'201',provider_call_id:'123'}});await expect(f.run()).rejects.toThrow();});
it('rejects another rep even with correct raw intent',async()=>{const f=fixture();f.event.targetId='999';await expect(f.run()).rejects.toThrow();});
it('does not guess missing source provenance',async()=>{const f=fixture();f.receipt.webhookSourceId='';await expect(f.run()).rejects.toThrow();expect(f.requests).toHaveLength(0);});
it('rejects missing frozen history after revocation rather than current fallback',async()=>{const f=fixture('201',{dialpad_connection_revisions:null});await expect(f.run()).rejects.toThrow();});
it('requires authoritative call ID when custom data absent',async()=>{const f=fixture();f.event.intentId=null;await expect(f.run()).resolves.toMatchObject({providerUserId:'201'});expect(f.requests.find(u=>u.pathname.endsWith('dialpad_voice_intents'))?.searchParams.get('provider_call_id')).toBe('eq.123');});
it('rejects candidate or substituted provider call',async()=>{const f=fixture();f.event.callId='999';await expect(f.run()).rejects.toThrow();});

it('rejects a verified signature from a different frozen provider company',async()=>{const f=fixture('201',{dialpad_voice_webhook_sources:{id:'source',org_id:org,connection_id:'foreign',connection_version:1},foreign_revision:{org_id:org,connection_id:'foreign',config_version:1,provider_company_id:'999',credential_reference:'env:DIALPAD_FOREIGN'}});await expect(f.run()).rejects.toThrow();});
