import { DialpadVoiceClient } from "../src/lib/dialpad-voice/client";
import { recordingConnectionResolver } from "../src/lib/dialpad-voice/recording-worker-store";
import { createDialpadVoiceAdminClient } from "../src/lib/dialpad-voice/database";
import { createFfmpegRecordingDecoder } from "../src/lib/dialpad-voice/ffmpeg-decoder";
import { processDialpadRecording } from "../src/lib/dialpad-voice/recording-worker";

async function main() {
  const orgId = process.env.DIALPAD_VOICE_ORG_ID ?? "";
  const bucket = process.env.DIALPAD_VOICE_RECORDING_BUCKET ?? "";
  if (process.env.DIALPAD_VOICE_RECORDING_WORKER_ENABLED !== "true" || !bucket ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new Error("Recording worker disabled or unconfigured");
  }
 type Base=import('../src/lib/dialpad-voice/database.generated').DialpadVoiceDatabase;
 type Table<R>={Row:R;Insert:never;Update:never;Relationships:[]};
 type HistoryDatabase=Omit<Base,'public'>&{public:Omit<Base['public'],'Tables'>&{Tables:Base['public']['Tables']&{
  dialpad_intent_configuration:Table<{org_id:string;intent_id:string;connection_id:string;connection_version:number}>;
  dialpad_connection_revisions:Table<{org_id:string;connection_id:string;config_version:number;provider_company_id:string;credential_reference:string}>;
 }}};
 const client=createDialpadVoiceAdminClient<HistoryDatabase>();
 const history:import('../src/lib/dialpad-voice/historical-connection').HistoricalConnectionStore={
  async readIntent(org,intent){const r=await client.from('dialpad_voice_intents').select('*').eq('org_id',org).eq('id',intent).maybeSingle();if(r.error)throw Error('history unavailable');return r.data;},
  async readConfiguration(org,intent){const r=await client.from('dialpad_intent_configuration').select('*').eq('org_id',org).eq('intent_id',intent).maybeSingle();if(r.error)throw Error('history unavailable');return r.data;},
  async readRevision(org,connection,version){const r=await client.from('dialpad_connection_revisions').select('*').eq('org_id',org).eq('connection_id',connection).eq('config_version',version).maybeSingle();if(r.error)throw Error('history unavailable');return r.data;},
 };
 const credentials:import('../src/lib/dialpad-voice/historical-connection').HistoricalCredentialAccess={
  async resolve(reference){if(!/^env:DIALPAD_[A-Z0-9_]{1,119}$/.test(reference))return undefined;return process.env[reference.slice(4)];},
  async getCompany(key){return new DialpadVoiceClient(key).getCompany();},
 };
  const result = await processDialpadRecording({
    client, orgId, resolveConnection: recordingConnectionResolver(history,credentials,orgId), bucket,
    decode: createFfmpegRecordingDecoder({ executable: process.env.DIALPAD_FFMPEG_PATH || "ffmpeg" }),
  });
  console.log(JSON.stringify({ result }));
}
main().catch(() => {
  console.error("Dialpad recording worker did not complete; inspect configuration and durable queue status.");
  process.exitCode = 1;
});
