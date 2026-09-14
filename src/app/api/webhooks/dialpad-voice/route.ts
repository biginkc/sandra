import { persistDialpadVoiceReceipt } from '@/lib/dialpad-voice/inbox';
import { createDialpadVoiceReceiver } from '@/lib/dialpad-voice/webhook-receiver';
import { loadDialpadWebhookSource } from '@/lib/dialpad-voice/webhook-source';
export const runtime='nodejs';
export async function POST(request:Request):Promise<Response>{
 if(process.env.DIALPAD_VOICE_EVENTS_ENABLED!=='true')return new Response(null,{status:404});
 try{
  const primary=process.env.DIALPAD_VOICE_WEBHOOK_SOURCE_ID??'';
  const previous=(process.env.DIALPAD_VOICE_WEBHOOK_PREVIOUS_SOURCE_IDS??'').split(',').map(id=>id.trim()).filter(Boolean);
  const ids=[primary,...previous];
  if(previous.length>3||new Set(ids).size!==ids.length)return new Response(null,{status:503});
  // Retry verification only, never persistence. Each retained signing key is
  // tied to its own immutable source; a signature cannot choose its source.
  for(const id of ids){
   const source=await loadDialpadWebhookSource(id);
   const response=await createDialpadVoiceReceiver({secret:source.secret,persist:receipt=>persistDialpadVoiceReceipt(source.orgId,receipt,source.sourceId)})(request.clone());
   if(response.status!==401)return response;
  }
  return new Response(null,{status:401});
 }catch{return new Response(null,{status:503});}
}
