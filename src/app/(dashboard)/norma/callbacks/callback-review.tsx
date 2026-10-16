"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { associateCallback, findCallbackLeads } from "./actions";
export function CallbackReview({callId,updatedAt}:{callId:string;updatedAt:string}) {
  const router=useRouter();
  const [query,setQuery]=useState("");
  const [leads,setLeads]=useState<{id:string;address:string}[]>([]);
  const [selected,setSelected]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  async function search() {
    setBusy(true);setSelected(null);setMessage("");
    try {const result=await findCallbackLeads(callId,query);setLeads(result.leads);setMessage(result.error??(result.leads.length?"":"No matching leads. Leave this call for review if the address is uncertain."));}
    catch {setMessage("Unable to search leads. Try again.");} finally {setBusy(false);}
  }
  async function associate() {
    if(!selected)return;setBusy(true);setMessage("");
    try {const result=await associateCallback(callId,selected,updatedAt);if(result.error)setMessage(result.error);else router.refresh();}
    catch {setMessage("Unable to save this review. Try again.");} finally {setBusy(false);}
  }
  return <div className="space-y-2">
    <p>Confirm the property with the caller before associating this callback. A matching phone number alone is insufficient.</p>
    <form className="flex gap-2" onSubmit={(event)=>{event.preventDefault();void search();}}>
      <Input aria-label="Search lead address" value={query} disabled={busy} onChange={(e)=>{setQuery(e.target.value);setSelected(null);setLeads([]);}} />
      <Button type="submit" disabled={busy||query.trim().length<3}>Search leads</Button>
    </form>
    {leads.length?<label className="block">Confirmed property<select className="block w-full rounded border p-2" aria-label="Confirmed property" value={selected??""} onChange={(e)=>setSelected(e.target.value||null)} disabled={busy}>
      <option value="">Choose a property</option>{leads.map((lead)=><option key={lead.id} value={lead.id}>{lead.address}</option>)}
    </select></label>:null}
    {selected?<Button disabled={busy} onClick={()=>void associate()}>Associate confirmed property</Button>:null}
    {message?<p role="status">{message}</p>:null}
  </div>;
}
