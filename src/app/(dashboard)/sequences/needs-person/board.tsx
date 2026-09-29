"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { BulkStartDripDialog } from "@/app/(dashboard)/leads/bulk-start-drip-dialog";
import { updatePropertyStatus } from "@/app/(dashboard)/leads/actions";
import { startDripForLeads } from "@/app/(dashboard)/sequences/actions";
import { StartDripPicker } from "@/components/sequences/start-drip-picker";
import { Button } from "@/components/ui/button";
import { DataTableFooter, DataTableShell } from "@/components/ui/data-table-shell";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { callAction } from "@/lib/errors/call-action";
import { NEEDS_PERSON_PAGE_SIZE, needsPersonPiles } from "../overview-model";
import type { NeedsPersonBucket, NeedsPersonCounts } from "../actions";
import type { NeedsPersonLead } from "./actions";

const PILES = [
  { key: "finished_no_reply", id: "finished-no-reply", title: "Finished, no reply", detail: "The drip finished without a reply. Decide what to do next." },
  { key: "couldnt_send", id: "couldnt-send", title: "Couldn’t send", detail: "A text could not be sent. Review the thread before restarting." },
  { key: "needs_sequence", id: "needs-drip", title: "Needs a drip", detail: "Marked for a drip, but none has started yet." },
] as const;

export function NeedsPersonBoard({ rows, counts, pages, openGroups }: {
  rows: NeedsPersonLead[];
  counts?: NeedsPersonCounts;
  pages?: Record<NeedsPersonBucket, number>;
  openGroups?: string;
}) {
  const router = useRouter();
  const piles = needsPersonPiles(rows);
  const totals = counts ?? Object.fromEntries(PILES.map((pile) => [pile.key, piles[pile.key].length])) as NeedsPersonCounts;
  const currentPages = pages ?? { finished_no_reply: 1, couldnt_send: 1, needs_sequence: 1 };
  const [expanded, setExpanded] = useState<Record<NeedsPersonBucket, boolean>>(() =>
    openGroups === undefined
      ? { finished_no_reply: true, couldnt_send: false, needs_sequence: true }
      : Object.fromEntries(PILES.map((pile) => [pile.key, openGroups.split(",").includes(pile.key)])) as Record<NeedsPersonBucket, boolean>);
  function pageHref(bucket: NeedsPersonBucket, page: number, anchor: string) {
    const params = new URLSearchParams();
    for (const pile of PILES) {
      const next = pile.key === bucket ? page : currentPages[pile.key];
      if (next > 1) params.set(pile.key, String(next));
    }
    params.set("open", PILES.filter((pile) => expanded[pile.key]).map((pile) => pile.key).join(","));
    return `/sequences/needs-person${params.size ? `?${params}` : ""}#${anchor}`;
  }
  const [selected, setSelected] = useState<string[]>([]);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [deadLead, setDeadLead] = useState<NeedsPersonLead | null>(null);
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  const [pending, startTransition] = useTransition();

  function markDead() {
    if (!deadLead) return;
    const lead = deadLead;
    startTransition(async () => {
      const result = await callAction(updatePropertyStatus(lead.property_id, "dead", lead.status), { successMessage: `${lead.address} marked dead`, fallbackMessage: "Could not mark lead dead" });
      if (result.ok) { setDeadLead(null); router.refresh(); }
    });
  }

  return <div className="space-y-7">
    <div className="grid gap-3 md:grid-cols-3" aria-label="Needs attention">
      {PILES.map((pile) => <a key={pile.key} href={`#${pile.id}`} className="rounded-xl border bg-card p-4 text-sm"><span className="text-muted-foreground">{pile.title}</span><strong className="mt-1 block font-heading text-2xl">{totals[pile.key]}</strong></a>)}
    </div>
    {PILES.map((pile) => {
      const leads = piles[pile.key];
      const shown = showAll[pile.key] ? leads : leads.slice(0, 5);
      const allSelected = leads.length > 0 && leads.every((lead) => selected.includes(lead.property_id));
      const page = currentPages[pile.key];
      const pageCount = Math.max(1, Math.ceil(totals[pile.key] / NEEDS_PERSON_PAGE_SIZE));
      return <section key={pile.key} id={pile.id} className="space-y-3">
        <button type="button" aria-expanded={expanded[pile.key]} onClick={() => setExpanded((current) => ({ ...current, [pile.key]: !current[pile.key] }))}
          className={`flex w-full items-center justify-between rounded-lg px-4 py-3 text-left text-sm font-bold text-white ${pile.key === "couldnt_send" ? "bg-red-700" : pile.key === "needs_sequence" ? "bg-blue-700" : "bg-zinc-600"}`}>
          <span>{expanded[pile.key] ? "⌄" : "›"} &nbsp; {pile.title.toUpperCase()} <span className="rounded-full bg-white/20 px-2">{totals[pile.key]}</span></span><span className="text-xs font-normal">{pile.detail}</span>
        </button>
        {expanded[pile.key] && <>
        {pile.key === "needs_sequence" && <div className="flex justify-end"><Button disabled={selected.length === 0} onClick={() => setBulkOpen(true)}>Start drip for {selected.length} selected</Button></div>}
        <DataTableShell><Table className="[&_th]:px-3 [&_td]:px-3"><TableHeader><TableRow>
          {pile.key === "needs_sequence" && <TableHead className="w-10"><input type="checkbox" aria-label="Select all leads needing a drip" checked={allSelected} onChange={() => setSelected(allSelected ? [] : leads.map((lead) => lead.property_id))} /></TableHead>}
          <TableHead>Lead</TableHead><TableHead>Reason</TableHead><TableHead className="text-right">Actions</TableHead>
        </TableRow></TableHeader><TableBody>
          {shown.map((lead) => <TableRow key={lead.property_id}>
            {pile.key === "needs_sequence" && <TableCell><input type="checkbox" aria-label={`Select ${lead.address}`} checked={selected.includes(lead.property_id)} onChange={() => setSelected((current) => current.includes(lead.property_id) ? current.filter((id) => id !== lead.property_id) : [...current, lead.property_id])} /></TableCell>}
            <TableCell><Link href={`/leads/${lead.property_id}`} className="font-medium hover:underline">{lead.address}</Link></TableCell>
            <TableCell className="text-muted-foreground">{lead.reason}</TableCell>
            <TableCell><div className="flex items-center justify-end gap-2">
              {lead.threadId ? <Link href={`/messages?thread=${encodeURIComponent(lead.threadId)}`} className="text-sm underline underline-offset-4">Open thread</Link> : <Link href={`/leads/${lead.property_id}`} className="text-sm underline underline-offset-4">Open lead</Link>}
              <StartDripPicker triggerLabel="Start drip" onChoose={async (sequenceId) => {
                const result = await startDripForLeads(sequenceId, [lead.property_id]);
                if (!result.ok) return { status: "failed", reason: result.error.message };
                const outcome = result.data.results[0] ?? { status: "failed" as const, reason: "No enrollment result." };
                if (outcome.status === "enrolled") router.refresh();
                return outcome;
              }} />
              {lead.status !== "dead" && <Button variant="ghost" size="sm" onClick={() => setDeadLead(lead)}>Mark dead</Button>}
            </div></TableCell>
          </TableRow>)}
          {leads.length === 0 && <TableRow><TableCell colSpan={pile.key === "needs_sequence" ? 4 : 3} className="py-8 text-center text-muted-foreground">No leads in this group.</TableCell></TableRow>}
        </TableBody></Table><DataTableFooter><span className="text-sm text-muted-foreground">Page {page} of {pageCount} · {totals[pile.key]} {totals[pile.key] === 1 ? "lead" : "leads"}</span><div className="flex gap-3">{leads.length > 5 && <button type="button" className="text-sm underline" onClick={() => setShowAll((current) => ({ ...current, [pile.key]: !current[pile.key] }))}>{showAll[pile.key] ? "Show fewer" : `Show all ${leads.length} on this page`}</button>}{page > 1 && <Link className="text-sm underline" href={pageHref(pile.key, page - 1, pile.id)}>Previous</Link>}{page < pageCount && <Link className="text-sm underline" href={pageHref(pile.key, page + 1, pile.id)}>Next</Link>}</div></DataTableFooter></DataTableShell>
        </>}
      </section>;
    })}
    <BulkStartDripDialog open={bulkOpen} leads={piles.needs_sequence.filter((lead) => selected.includes(lead.property_id)).map((lead) => ({ id: lead.property_id, address: lead.address }))} onClose={() => setBulkOpen(false)} onComplete={() => { setSelected([]); router.refresh(); }} />
    <Dialog open={!!deadLead} onOpenChange={(open) => { if (!open) setDeadLead(null); }}><DialogContent>
      <DialogHeader><DialogTitle>Mark this lead dead?</DialogTitle><DialogDescription>{deadLead?.address} will move to the Dead stage.</DialogDescription></DialogHeader>
      <DialogFooter><Button variant="outline" disabled={pending} onClick={() => setDeadLead(null)}>Cancel</Button><Button disabled={pending} onClick={markDead}>Mark dead</Button></DialogFooter>
    </DialogContent></Dialog>
  </div>;
}
