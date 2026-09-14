import 'server-only';
import { HistoricalConnectionError, resolveHistoricalDialpadConnection, type HistoricalCredentialAccess, type HistoricalConnectionStore } from './historical-connection';
import { DialpadVoiceClient } from './client';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Json } from '@/lib/supabase/types';
import type { DialpadVoiceDatabase } from './database.generated';
import type { ReconciliationJob, ReconciliationStore } from './reconciliation';
export type ReconciliationDatabase = Omit<DialpadVoiceDatabase,'public'> & {public: Omit<DialpadVoiceDatabase['public'],'Functions'> & {Functions: DialpadVoiceDatabase['public']['Functions'] & {
 fn_claim_dialpad_rest_reconciliation:{Args:{p_org_id:string};Returns:ReconciliationJob[]};
 fn_apply_dialpad_rest_reconciliation:{Args:{p_job_id:string;p_lease_token:string;p_payload:Json};Returns:boolean};
 fn_fail_dialpad_rest_reconciliation:{Args:{p_job_id:string;p_lease_token:string;p_permanent:boolean;p_error_code:string};Returns:boolean};
}}};
export function reconciliationStore(client:SupabaseClient<ReconciliationDatabase>,orgId:string, history:HistoricalConnectionStore, credentials:HistoricalCredentialAccess, makeProvider:(key:string)=>Pick<DialpadVoiceClient,'getCall'> = key=>new DialpadVoiceClient(key)):ReconciliationStore {
 return {
  async resolveClient(job){
   // Authoritative binding only: response candidate receipts are never queried.
   const {data,error}=await client.from('dialpad_voice_intents').select('id,org_id,provider_call_id').eq('org_id',orgId).eq('provider_call_id',job.provider_call_id).limit(2);
   if(error)throw new HistoricalConnectionError('history_read_unavailable');
   if(!data||data.length!==1||data[0].org_id!==orgId||data[0].provider_call_id!==job.provider_call_id)throw new HistoricalConnectionError('history_unavailable');
   const resolved=await resolveHistoricalDialpadConnection(history,credentials,{orgId,intentId:data[0].id});
   const provider=makeProvider(resolved.apiKey);
   return {providerUserId:resolved.providerUserId,getCall:(id:string)=>provider.getCall(id)};
  },
  async deferBudget(){const {error}=await client.rpc("fn_defer_dialpad_detail_budget",{p_org_id:orgId,p_seconds:60});if(error)throw new Error("Reconciliation budget unavailable");},
  async claim(){const {data,error}=await client.rpc('fn_claim_dialpad_rest_reconciliation',{p_org_id:orgId});if(error||!data)throw new Error('Reconciliation claim unavailable');return data;},
  async apply(job,payload){const {data,error}=await client.rpc('fn_apply_dialpad_rest_reconciliation',{p_job_id:job.id,p_lease_token:job.lease_token,p_payload:payload as Json});if(error||typeof data!=='boolean')throw new Error('Reconciliation apply unavailable');return data;},
  async fail(job,permanent,code){const {data,error}=await client.rpc('fn_fail_dialpad_rest_reconciliation',{p_job_id:job.id,p_lease_token:job.lease_token,p_permanent:permanent,p_error_code:code});if(error||typeof data!=='boolean')throw new Error('Reconciliation failure unavailable');return data;},
 };
}
