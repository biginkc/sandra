import 'server-only';
import { HistoricalConnectionError, resolveHistoricalDialpadConnection, type HistoricalConnectionStore, type HistoricalCredentialAccess } from './historical-connection';
/** Only persisted authoritative intent.call_id may establish artifact routing.
 * Candidate response receipts and current grants are deliberately not inputs. */
export function recordingConnectionResolver(history: HistoricalConnectionStore, credentials: HistoricalCredentialAccess, orgId: string) {
 return async (artifact: {org_id:string;intent_id:string|null;provider_call_id:string}) => {
  if(artifact.org_id!==orgId||!artifact.intent_id)throw new HistoricalConnectionError('history_unavailable');
  let intent:unknown;
  try{intent=await history.readIntent(orgId,artifact.intent_id);}catch{throw new HistoricalConnectionError('history_read_unavailable');}
  if(!intent||typeof intent!=='object'||Array.isArray(intent)||!('provider_call_id' in intent)||intent.provider_call_id!==artifact.provider_call_id)throw new HistoricalConnectionError('history_unavailable');
  return resolveHistoricalDialpadConnection({...history,readIntent:async()=>intent},credentials,{orgId,intentId:artifact.intent_id});
 };
}
