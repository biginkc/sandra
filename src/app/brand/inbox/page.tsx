import Link from "next/link";
import { previewStates } from "./_fixtures";

export default function InboxBrandIndex() {
  return <main className="mx-auto max-w-4xl space-y-5 p-8"><p className="text-xs font-bold uppercase tracking-widest text-slate-500">Sandra · no auth fixture</p><h1 className="text-3xl font-semibold">Inbox reply states</h1><p className="max-w-2xl text-slate-600">Visual fixture routes for the production Inbox reply UI. They never call the reply API or use customer data.</p><ul className="grid gap-2 sm:grid-cols-2">{previewStates.map(state => <li key={state}><Link className="block rounded-lg border px-3 py-2 text-sm hover:bg-slate-50" href={`/brand/inbox/reply/${state}`}>{state.replaceAll("-", " ")}</Link></li>)}</ul><Link className="block rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 text-sm font-medium" href="/brand/inbox/receipt/sending">Open receipt-page fixtures →</Link></main>;
}
