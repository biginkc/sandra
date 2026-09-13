import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {expect,it,vi} from "vitest";
vi.mock("@/lib/messaging/registry",()=>({getMessagingProvider:vi.fn()}));
import {getMessagingProvider} from "@/lib/messaging/registry";
import {sendSmsToContact} from "@/lib/messaging/send";
import {computeConsentState} from "@/lib/messaging/consent";
import {evaluateSuppression} from "@/lib/messaging/suppression";
const base="experiments/inbox-operation-domain/";
it("blocks a real later active enrollment using canonical opt-out data before any provider call",async()=>{
 if(process.env.INBOX_OWNED_SENDER_PROOF!=="1")throw Error("Explicit offline fixture proof required");
 const raw=readFileSync(base+"future-enrollment-snapshot.json","utf8");const snapshot=JSON.parse(raw);
 expect(snapshot.enrollment_status).toBe("active");
 expect(snapshot.properties.find((p:{id:string})=>p.id===snapshot.property_id).outreach_dispo).toBeNull();
 const sendSms=vi.fn(()=>{throw Error("Provider call forbidden");});
 vi.mocked(getMessagingProvider).mockReturnValue({providerId:"owned-offline-proof",sendSms} as never);
 const client={from(table:string){
  if(!["properties","contacts","consent_events"].includes(table))throw Error("Unexpected database access: "+table);
  let rows=[...snapshot[table]];let single=false;
  const result=()=>({data:single?(rows[0]??null):rows,error:null});
  const query={select(){return query;},eq(key:string,value:unknown){rows=rows.filter(row=>row[key]===value);return query;},order(key:string,{ascending}:{ascending:boolean}){rows.sort((a,b)=>String(a[key]).localeCompare(String(b[key]))*(ascending?1:-1));return query;},limit(n:number){rows=rows.slice(0,n);return query;},maybeSingle(){single=true;return Promise.resolve(result());},then(resolve:(r:unknown)=>unknown){return Promise.resolve(result()).then(resolve);}};
  return query;
 }};
 const outcome=await sendSmsToContact(client as never,{contactId:snapshot.contact_id,propertyId:snapshot.property_id,body:"Offline suppression proof",automated:true} as never);
 expect(outcome.status).toBe("blocked_terminal_dispo");expect(sendSms).not.toHaveBeenCalled();
 const consent=computeConsentState(snapshot.consent_events);expect(consent).toBe("opted_out");
 expect(evaluateSuppression({outreachDispo:null,consentState:consent,doNotContact:false,smsOptedOut:false}).suppressed).toBe(true);
 writeFileSync(base+"sender-proof-evidence.json",JSON.stringify({actual_future_enrollment_status:snapshot.enrollment_status,actual_production_sender_outcome:outcome,provider_calls:sendSms.mock.calls.length,consent_fallback_suppressed:true,snapshot_sha256:createHash("sha256").update(raw).digest("hex"),source_hashes:Object.fromEntries(["src/lib/messaging/send.ts","src/lib/messaging/consent.ts","src/lib/messaging/suppression.ts"].map(file=>[file,createHash("sha256").update(readFileSync(file)).digest("hex")])),limits:["Database responses use exported canonical fixture rows; no PostgREST transport exercised","Provider registry stubbed; no provider calls permitted","Consent-only fallback deliberately models a stale false cache flag without changing the canonical fixture"]},null,2)+"\n");
});
