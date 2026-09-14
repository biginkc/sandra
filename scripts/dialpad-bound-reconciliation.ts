export {};
/** Explicit org-scoped run; no scheduler and no default org or provider key.
 * Call snapshots and credentials are never printed. */
async function main() {
 if(process.env.DIALPAD_BOUND_RECONCILIATION_ENABLED!=='true') throw new Error('Bound reconciliation is disabled');
 const orgId=process.env.DIALPAD_RECONCILIATION_ORG_ID;
 if(!orgId||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId))throw Error('Explicit organization required');
 const [{createDialpadVoiceAdminClient},{DialpadVoiceClient},{reconciliationStore},{reconcileBoundDialpadCalls}]=await Promise.all([
 import('../src/lib/dialpad-voice/database'),import('../src/lib/dialpad-voice/client'),import('../src/lib/dialpad-voice/reconciliation-store'),import('../src/lib/dialpad-voice/reconciliation')]);
 type Base=import('../src/lib/dialpad-voice/reconciliation-store').ReconciliationDatabase;
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
 console.log(await reconcileBoundDialpadCalls(reconciliationStore(client,orgId,history,credentials)));
}
main().catch(()=>{console.error('Bound reconciliation did not complete');process.exitCode=1;});
