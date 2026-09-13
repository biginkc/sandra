import 'server-only';
import { normalizeDialpadCallEvent, InvalidDialpadCallEvent } from './call-event';
import { DialpadVoiceError } from './client';
export type ReconciliationJob = { id:string; provider_call_id:string; lease_token:string };
export interface ReconciliationStore {
 claim():Promise<ReconciliationJob[]>;
 deferBudget():Promise<void>;
 apply(job:ReconciliationJob,payload:Record<string,unknown>):Promise<boolean>;
 fail(job:ReconciliationJob,permanent:boolean,code:string):Promise<boolean>;
}
/** Existing bound calls only; no provider mutations, synthesized correlation, or credit. */
export async function reconcileBoundDialpadCalls(store:ReconciliationStore,client:{getCall(id:string):Promise<Record<string,unknown>>}) {
 const counts={acknowledgedReceipts:0,failed:0,leaseLost:0};
 for(const job of await store.claim()) {
  try {
   const payload=await client.getCall(job.provider_call_id);
   const event=normalizeDialpadCallEvent(payload);
   if(event.callId!==job.provider_call_id) throw new InvalidDialpadCallEvent();
   if(await store.apply(job,payload)) counts.acknowledgedReceipts++; else counts.leaseLost++;
  } catch(error) {
   if(error instanceof DialpadVoiceError && error.status===429) await store.deferBudget();
   const invalid=error instanceof InvalidDialpadCallEvent;
   const denied=error instanceof DialpadVoiceError && [401,403].includes(error.status??0);
   if(await store.fail(job,invalid||denied,invalid?'snapshot_invalid':denied?'permission_denied':'provider_unavailable')) counts.failed++;
   else counts.leaseLost++;
  }
 }
 return counts;
}
