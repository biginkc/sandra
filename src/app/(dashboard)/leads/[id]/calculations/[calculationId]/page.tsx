import Link from 'next/link';
import { OPERATOR_TIME_ZONE } from '@/lib/messages/message-metrics';
import { notFound } from 'next/navigation';
import { getCalculation, getCalculatorLead, getReadableCalculatorLead } from '@/lib/calculators/server';
import { EXPENSE_FIELDS, formatDollars, formatListingPercentage } from '@/lib/calculators/closr-v1';
export default async function SavedCalculationPage({params}:{params:Promise<{id:string;calculationId:string}>}) {
  const {id,calculationId}=await params;
  const saved=await getCalculation(calculationId).catch(()=>null);
  if(!saved||saved.property_id!==id) notFound();
  const lead=await getReadableCalculatorLead(id).catch(()=>null);if(!lead) notFound();
  const canEdit=await getCalculatorLead(id).then(()=>true).catch(()=>false);
  const money=(v:number|null)=>v===null?'Blank (treated as $0)':formatDollars(v);
  const inputs=saved.inputs,r=saved.results,d=saved.decision;
  const rows:[string,string][]=[['As-is market value',money(inputs.asIs)],['Listing percentage',inputs.listingPercentage===null?'Blank (0%)':`${formatListingPercentage(inputs.listingPercentage)}%`],['Desired profit',money(inputs.profit)],...EXPENSE_FIELDS.map(([key,label]):[string,string]=>[label,money(inputs[key])]),['ARV',money(inputs.arv)],['Investor rehab',money(inputs.rehab)]];
  const results:[string,number][]=[['Commission (4%)',r.commission],['Listing price',r.listing],['Itemized expenses',r.expenses],['Equity Protection',r.equity],['Family Placement',r.family],['Secure Close',r.secure],['Rapid Relief',r.rapid],['ARV × 70%',r.arv70],['Investor price',r.investor],['Seller offer · $40,000 fee',r.offers.fee40000],['Seller offer · $30,000 fee',r.offers.fee30000],['Seller offer · $20,000 fee',r.offers.fee20000],['Seller offer · $10,000 fee',r.offers.fee10000]];
  return <main className="space-y-5 bg-stone-100 p-4 text-stone-900 md:p-7">
    <Link href={`/leads/${id}#calculations`} className="text-sm underline">Back to lead calculations</Link>
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">Offer calculation · v{saved.version}</h1><p>{lead.address} · {lead.seller}</p></div>
    {canEdit?<Link className="rounded-full bg-stone-900 px-5 py-3 text-sm font-semibold text-white" href={`/calculators?calculationId=${saved.id}`}>Create a new version</Link>:null}</div>
    <p className="text-sm text-stone-600">Saved {new Date(saved.created_at).toLocaleString('en-US',{timeZone:OPERATOR_TIME_ZONE})} · Read-only saved inputs and results · {saved.formula_version}</p>
    <div className="grid gap-5 lg:grid-cols-2">{[['Inputs',rows],['Results',results.map(([label,value])=>[label,formatDollars(value)])]].map(([title,items])=><section key={String(title)} className="overflow-hidden rounded-2xl border bg-white"><h2 className="border-b p-4 text-lg font-bold">{String(title)}</h2><dl>{(items as [string,string][]).map(([label,value])=><div key={label} className="grid grid-cols-2 border-b px-4 py-2 text-sm"><dt>{label}</dt><dd className="text-right tabular-nums">{value}</dd></div>)}</dl></section>)}</div>
    <section className="space-y-2 rounded-2xl border bg-white p-5"><h2 className="font-bold">Recorded decision</h2><p>Approach: {d.approach} · Program: {d.program.replaceAll('_',' ')} · Fee tier: {formatDollars(d.feeTier)}</p><p>Proposed offer: {d.proposedOffer===null?'Not recorded':money(d.proposedOffer)}</p><h3 className="font-semibold">Negotiated terms</h3><p className="whitespace-pre-wrap">{d.terms||'Not recorded'}</p><h3 className="font-semibold">Seller motivation</h3><p className="whitespace-pre-wrap">{d.motivation||'Not recorded'}</p><p className="text-xs text-stone-500">Lead association: {saved.provenance.source.replaceAll('_',' ')}. Saving a calculation does not send an offer.</p></section>
  </main>;
}
