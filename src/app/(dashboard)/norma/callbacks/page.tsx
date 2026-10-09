import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { createClient } from "@/lib/supabase/server";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { canAccessMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import { CallbackReview } from "./callback-review";
export const metadata={title:"Norma callbacks · Sandra CRM"};
export default async function NormaCallbacksPage({searchParams}:{searchParams:Promise<{page?:string;view?:string}>}) {
  const params=await searchParams;
  const page=typeof params.page==="string"&&/^\d{1,4}$/.test(params.page)?Math.max(1,Number(params.page)):1;
  const all=params.view==="all";
  const client=await createClient();
  const {data:{user},error:authError}=await client.auth.getUser();
  if(authError||!user)redirect("/login");
  if(!canAccessMessagesAndLeadsBoard(await getCallerMembershipsOrThrow()))notFound();
  let query=client.from("norma_inbound_calls").select("id,from_e164,to_e164,completed,recording_state,review_state,property_id,created_at,updated_at,reconciliation_state");
  if(!all)query=query.eq("review_state","needs_review");
  const {data:calls,error}=await query.order("created_at",{ascending:false}).order("id").range((page-1)*50,page*50-1);
  return <Page><PageHeader title="Norma callbacks" description="Review inbound calls and associate only a confirmed property." />
    <nav aria-label="Callback views" className="flex gap-4"><Link href="/norma/callbacks">Needs review</Link><Link href="/norma/callbacks?view=all">All callbacks</Link></nav>
    {error?<p role="alert">Unable to load callbacks. Try again later.</p>:!calls?.length?<p>No callbacks in this view.</p>:<div className="space-y-4">{calls.map((call)=><article key={call.id} className="space-y-3 rounded-lg border p-4">
      <h2 className="font-semibold">Callback from {call.from_e164}</h2>
      <p>{new Date(call.created_at).toLocaleString("en-US",{timeZone:"America/Chicago"})} CT · {call.completed?"Call completed":"Completion pending"}</p>
      <p>{call.recording_state==="not_recorded"?"The provider reported that recording was disabled.":call.recording_state==="reported_available"?"Recording reported available.":call.reconciliation_state==="unavailable"?"Recording is not available yet. Try again later.":"Recording may still be processing."}</p>
      {call.recording_state!=="not_recorded"?<audio controls preload="none" aria-label={`Callback recording from ${call.from_e164}`} src={`/api/norma/inbound/${call.id}/recording`} className="w-full" />:null}
      <p className="text-sm">If audio is unavailable, try again later.</p>
      {call.property_id?<Link className="underline" href={`/leads/${call.property_id}`}>Open associated lead</Link>:call.review_state==="associated"?<p>The associated lead was removed. The review history has been retained.</p>:<CallbackReview callId={call.id} updatedAt={call.updated_at} />}
    </article>)}</div>}
    <nav aria-label="Callback pages" className="flex gap-4">{page>1?<Link href={`/norma/callbacks?page=${page-1}${all?"&view=all":""}`}>Previous</Link>:null}{calls?.length===50?<Link href={`/norma/callbacks?page=${page+1}${all?"&view=all":""}`}>Next</Link>:null}</nav>
  </Page>;
}
