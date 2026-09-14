import {createDialpadVoiceAdminClient} from '../src/lib/dialpad-voice/database';
import {processDialpadVoiceEvents} from '../src/lib/dialpad-voice/event-worker';
import {createVoiceEventWorkerStore} from '../src/lib/dialpad-voice/event-worker-store';
import {resolveConfiguredEventRoute} from '../src/lib/dialpad-voice/event-routing';
import {DialpadVoiceClient} from '../src/lib/dialpad-voice/client';
import {ingestDialpadInsights} from '../src/lib/dialpad-voice/insights';
import type {DialpadInsightsDatabase} from '../src/lib/dialpad-voice/insights-database.generated';
import type {EventConfigurationDatabase} from '../src/lib/dialpad-voice/event-configuration-database';
async function main(){
 const orgId=process.env.DIALPAD_VOICE_ORG_ID??'';
 if(process.env.DIALPAD_VOICE_WORKER_ENABLED!=='true'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId))throw Error('Worker disabled or unconfigured');
 const client=createDialpadVoiceAdminClient<EventConfigurationDatabase>();const insightsClient=createDialpadVoiceAdminClient<DialpadInsightsDatabase>();
 const store=createVoiceEventWorkerStore(client,orgId,async(receipt,event)=>{
  const route=await resolveConfiguredEventRoute(client,receipt,event);
  const apiKey=process.env[route.credentialReference.slice(4)]??'';
  const company=await new DialpadVoiceClient(apiKey).getCompany();if(company.id!==route.providerCompanyId)throw Error('Historical credential company mismatch');
  await ingestDialpadInsights({client:insightsClient,orgId,providerCallId:event.callId,state:event.state,payload:receipt.payload,apiKey});
 },async(receipt,event)=>{await resolveConfiguredEventRoute(client,receipt,event);});
 console.log(JSON.stringify(await processDialpadVoiceEvents({store,orgId})));
}
main().catch(()=>{console.error('Dialpad voice worker did not complete; inspect durable queue status.');process.exitCode=1;});
