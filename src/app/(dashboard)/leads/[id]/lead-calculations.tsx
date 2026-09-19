'use client';
import Link from 'next/link';
import { OPERATOR_TIME_ZONE } from '@/lib/messages/message-metrics';
import { useState } from 'react';
import { Calculator, Plus } from 'lucide-react';
import type { CalculatorSnapshot } from '@/lib/calculators/types';
import { formatDollars } from '@/lib/calculators/closr-v1';
import { loadLeadCalculations } from '../../calculators/actions';

export function LeadCalculations({propertyId,initial,loadError,canEdit=false}:{propertyId:string;initial:CalculatorSnapshot[];loadError?:string;canEdit?:boolean}) {
  const [rows,setRows]=useState(initial),[error,setError]=useState(loadError??''),[busy,setBusy]=useState(false);
  const [hasMore,setHasMore]=useState(initial.length===20);
  async function load() {
    setBusy(true);
    try {
      const result=await loadLeadCalculations(propertyId,rows.length?{id:rows[rows.length-1].id,createdAt:rows[rows.length-1].created_at}:null);
      if(!result.ok) {setError(result.error);return;}
      setRows([...rows,...result.data.filter(row=>!rows.some(existing=>existing.id===row.id))]);setHasMore(result.data.length===20);setError('');
    } catch {setError('Calculations could not load. Please retry.');} finally {setBusy(false);}
  }
  return <section id="calculations" aria-labelledby="calculations-heading" className="rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="calculations-heading" className="flex items-center gap-2 font-semibold"><Calculator className="size-4"/>Calculations</h2>
      {canEdit?<Link className="inline-flex items-center gap-1 rounded-full border px-3 py-2 text-sm font-semibold" href={`/calculators?leadId=${propertyId}`}><Plus className="size-4"/>New calculation</Link>:null}
    </div>
    {error?<p role="alert" className="mt-3 text-sm text-destructive">{error}</p>:null}
    {!rows.length&&!error?<p className="mt-3 text-sm text-muted-foreground">No saved calculations yet.</p>:null}
    <ul className="mt-3 divide-y">{rows.map(row=><li key={row.id} className="py-2 text-sm">
      <Link href={`/leads/${propertyId}/calculations/${row.id}`} className="font-medium underline underline-offset-2">v{row.version} · {row.decision.approach==='novation'?'Novation':'Wholesale'} · {row.decision.proposedOffer===null?'No proposed offer':formatDollars(row.decision.proposedOffer)}</Link>
      <time className="ml-2 text-xs text-muted-foreground" dateTime={row.created_at}>{new Date(row.created_at).toLocaleString('en-US',{timeZone:OPERATOR_TIME_ZONE})}</time>
    </li>)}</ul>
    {error||hasMore?<button type="button" onClick={load} disabled={busy} className="mt-2 rounded-full border px-3 py-2 text-sm">{busy?'Loading…':error?'Retry':'Load more'}</button>:null}
  </section>;
}
