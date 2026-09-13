import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Json } from '@/lib/supabase/types';
import type { DialpadVoiceDatabase } from './database.generated';
import type { ReconciliationJob, ReconciliationStore } from './reconciliation';
export type ReconciliationDatabase = Omit<DialpadVoiceDatabase,'public'> & {public: Omit<DialpadVoiceDatabase['public'],'Functions'> & {Functions: DialpadVoiceDatabase['public']['Functions'] & {
 fn_claim_dialpad_rest_reconciliation:{Args:{p_org_id:string};Returns:ReconciliationJob[]};
 fn_apply_dialpad_rest_reconciliation:{Args:{p_job_id:string;p_lease_token:string;p_payload:Json};Returns:boolean};
 fn_fail_dialpad_rest_reconciliation:{Args:{p_job_id:string;p_lease_token:string;p_permanent:boolean;p_error_code:string};Returns:boolean};
}}};
export function reconciliationStore(client:SupabaseClient<ReconciliationDatabase>,orgId:string):ReconciliationStore {
 return {
  async deferBudget(){const {error}=await client.rpc("fn_defer_dialpad_detail_budget",{p_org_id:orgId,p_seconds:60});if(error)throw new Error("Reconciliation budget unavailable");},
  async claim(){const {data,error}=await client.rpc('fn_claim_dialpad_rest_reconciliation',{p_org_id:orgId});if(error||!data)throw new Error('Reconciliation claim unavailable');return data;},
  async apply(job,payload){const {data,error}=await client.rpc('fn_apply_dialpad_rest_reconciliation',{p_job_id:job.id,p_lease_token:job.lease_token,p_payload:payload as Json});if(error||typeof data!=='boolean')throw new Error('Reconciliation apply unavailable');return data;},
  async fail(job,permanent,code){const {data,error}=await client.rpc('fn_fail_dialpad_rest_reconciliation',{p_job_id:job.id,p_lease_token:job.lease_token,p_permanent:permanent,p_error_code:code});if(error||typeof data!=='boolean')throw new Error('Reconciliation failure unavailable');return data;},
 };
}
