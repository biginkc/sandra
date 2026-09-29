"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight, Copy, Droplet, Plus } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StartDripPicker } from "@/components/sequences/start-drip-picker";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DataTableFooter, DataTableShell } from "@/components/ui/data-table-shell";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cancelEnrollment, changeDripAction, pauseEnrollmentAction, type SequenceRow } from "../actions";
import { copySequenceSteps } from "./detail-actions";
import { runSelectedEnrollmentAction, type EnrollmentActionOutcome } from "./detail-model";
import type { DripDetail, DripPerson } from "./detail-data";

function dateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";
}

function StepStrip({ detail }: { detail: DripDetail }) {
  const ref = useRef<HTMLDivElement>(null);
  const [first, setFirst] = useState(0);
  const steps = detail.sequence.steps;
  const visible = Math.min(4, steps.length);
  function move(delta: number) {
    const next = Math.max(0, Math.min(steps.length - visible, first + delta));
    setFirst(next);
    const item = ref.current?.firstElementChild as HTMLElement | null;
    if (item) ref.current?.scrollTo?.({ left: next * (item.offsetWidth + 12), behavior: "smooth" });
  }
  return <section className="space-y-3" aria-label="Steps">
    <div className="flex items-center justify-between gap-3"><div><h2 className="font-heading text-xl">By step</h2><p className="text-sm text-muted-foreground">Sent, replied, and waiting for the next step.</p></div>
      <div className="flex shrink-0 items-center gap-2" aria-live="polite"><span className="text-sm font-medium">{steps.length} steps · showing {first + 1}–{Math.min(first + visible, steps.length)} of {steps.length}</span>
        <Button variant="outline" size="icon" aria-label="Previous steps" disabled={first === 0} onClick={() => move(-1)}><ChevronLeft className="size-4" /></Button>
        <Button variant="outline" size="icon" aria-label="Next steps" disabled={first + visible >= steps.length} onClick={() => move(1)}><ChevronRight className="size-4" /></Button>
      </div></div>
    <div ref={ref} className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2" onScroll={(event) => {
      const element = event.currentTarget;
      const item = element.firstElementChild as HTMLElement | null;
      if (item) setFirst(Math.min(steps.length - visible, Math.max(0, Math.round(element.scrollLeft / (item.offsetWidth + 12)))));
    }}>
      {steps.map((step, index) => {
        const elapsed = steps.slice(0, index + 1).reduce((total, item) => total + item.delay_after_previous_minutes, 0);
        const stat = detail.stats.find((row) => row.step_id === step.id);
        return <article key={step.id} className="w-[calc((100%-2.25rem)/4)] min-w-64 shrink-0 snap-start rounded-xl border bg-card p-4">
          <p className="text-xs font-medium text-muted-foreground">Step {index + 1} · {elapsed === 0 ? "immediately" : `day ${Math.ceil(elapsed / 1440)}`}{index === steps.length - 1 ? " · last" : ""}</p>
          <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1"><span><strong className="font-heading text-2xl">{stat?.sent ?? 0}</strong> <span className="text-xs text-muted-foreground">sent</span></span><span><strong className="text-lg text-green-700">{stat?.replied ?? 0}</strong> <span className="text-xs text-muted-foreground">replied</span></span><span><strong className="text-lg text-blue-700">{stat?.waiting ?? 0}</strong> <span className="text-xs text-muted-foreground">waiting</span></span></div>
          <p className="mt-3 truncate text-xs text-muted-foreground" title={step.template_body ?? undefined}>{step.template_body || (step.action_type === "change_status" ? `Change status to ${step.target_status}` : "Saved text template")}</p>
        </article>;
      })}
    </div>
  </section>;
}

export function DripDetailView({ detail, sources, isAdmin }: { detail: DripDetail; sources: SequenceRow[]; isAdmin: boolean }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<EnrollmentActionOutcome[]>([]);
  const [filter, setFilter] = useState("All");
  const [copyOpen, setCopyOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const sequence = detail.sequence;
  const rows = detail.people.filter((person) => filter === "All" || person.status === filter);
  const actionable = rows.filter((person) => person.canAct).map((person) => person.enrollmentId);
  const allSelected = actionable.length > 0 && actionable.every((id) => selected.includes(id));
  const selectedActionable = selected.filter((id) => detail.people.some((person) => person.enrollmentId === id && person.canAct));

  function run(action: (id: string) => ReturnType<typeof cancelEnrollment>) {
    startTransition(async () => {
      setResults(await runSelectedEnrollmentAction(selectedActionable, action));
      setSelected([]);
      setStopOpen(false);
      router.refresh();
    });
  }
  function copy(sourceId: string) {
    startTransition(async () => {
      const result = await copySequenceSteps(sequence.id, sourceId);
      setResults([{ id: sourceId, ok: result.ok, message: result.ok ? `${result.data.copied} steps copied.` : result.error.message }]);
      if (result.ok) { setCopyOpen(false); router.refresh(); }
    });
  }
  const filters = ["All", "Waiting", "Replied", "Finished, no reply", "Stopped", "Couldn’t send", "Paused"];
  return <Page>
    <PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }, { label: sequence.name }]} title={sequence.name}
      description={`${sequence.steps.length} steps · ${detail.peopleCount} people enrolled · ${sequence.steps.length === 0 ? "Needs steps before leads can start" : sequence.archived_at ? "Archived" : sequence.active ? "Open to new leads" : "Closed to new leads"}`}
      actions={<div className="flex items-center gap-2">{isAdmin && <Link href={`/sequences/${sequence.id}/edit`}><Button>Edit drip</Button></Link>}<Link href="/sequences"><Button variant="outline">Back to list</Button></Link></div>} />
    {sequence.steps.length ? <StepStrip detail={detail} /> : <div className="rounded-2xl border bg-card p-8 text-center"><Droplet className="mx-auto mb-3 size-10 text-primary" /><h2 className="font-heading text-xl">No steps yet</h2><p className="mb-4 text-sm text-muted-foreground">Add the first text or copy steps from another drip.</p>
      {isAdmin && <div className="flex justify-center gap-2"><Link href={`/sequences/${sequence.id}/edit`}><Button><Plus className="size-4" /> Add step</Button></Link><Button variant="outline" onClick={() => setCopyOpen(true)}><Copy className="size-4" /> Copy steps from another drip</Button></div>}</div>}
    {sequence.steps.length > 0 && detail.peopleCount === 0 && <div className="rounded-2xl border bg-card p-6"><h2 className="font-heading text-lg">Ready. No leads enrolled yet.</h2><p className="mt-1 text-sm text-muted-foreground">The step counts will appear as leads enter this drip.</p><div className="mt-4 flex flex-wrap gap-2"><Link href="/messages"><Button variant="outline" size="sm">Open Messages</Button></Link><Link href="/leads"><Button variant="outline" size="sm">Open Leads</Button></Link><Link href="/sequences/needs-person"><Button variant="outline" size="sm">Needs a drip</Button></Link></div></div>}
    <section className="space-y-3"><div className="flex flex-wrap items-center gap-2"><h2 className="mr-3 font-heading text-xl">People in this drip</h2>{filters.map((label) => <Button key={label} size="sm" variant={filter === label ? "default" : "outline"} onClick={() => { setFilter(label); setSelected([]); }}>{label} {label === "All" ? detail.peopleCount : detail.people.filter((person) => person.status === label).length}</Button>)}</div>
      {selectedActionable.length > 0 && <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3"><strong className="mr-2 text-sm">{selectedActionable.length} selected</strong>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => run(pauseEnrollmentAction)}>Pause texts</Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => setStopOpen(true)}>Stop drip</Button>
        <StartDripPicker triggerLabel="Move to another drip" onChoose={async (sequenceId) => {
          const outcomes = await runSelectedEnrollmentAction(selectedActionable, async (id) => {
            const result = await changeDripAction(id, sequenceId);
            return result.ok && result.data.status !== "enrolled" ? { ok: false as const, error: { code: "MOVE_FAILED", message: result.data.reason } } : result;
          });
          setResults(outcomes); setSelected([]); router.refresh();
          const failed = outcomes.filter((outcome) => !outcome.ok).length;
          return { status: failed ? "failed" as const : "enrolled" as const, reason: failed ? `${failed} of ${outcomes.length} moves failed. See results below.` : `${outcomes.length} leads moved.` };
        }} />
        <Button size="sm" variant="ghost" onClick={() => setSelected([])}>Clear</Button></div>}
      {results.length > 0 && <div role="status" className="rounded-xl border bg-card p-3 text-sm"><strong>Action results: {results.filter((result) => result.ok).length} succeeded, {results.filter((result) => !result.ok).length} failed.</strong>{results.map((result) => <p key={result.id} className={result.ok ? "text-muted-foreground" : "text-destructive"}>{detail.people.find((person) => person.enrollmentId === result.id)?.name ?? result.id}: {result.message}</p>)}</div>}
      <DataTableShell><Table className="[&_th]:px-3 [&_td]:px-3"><TableHeader><TableRow><TableHead className="w-10"><input type="checkbox" aria-label="Select all actionable leads shown" checked={allSelected} onChange={() => setSelected(allSelected ? selected.filter((id) => !actionable.includes(id)) : [...new Set([...selected, ...actionable])])} /></TableHead><TableHead>Lead</TableHead><TableHead>What’s happening</TableHead><TableHead>Step</TableHead><TableHead>Next send</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((person) => <PersonRow key={person.enrollmentId} person={person} stepCount={sequence.steps.length} selected={selected.includes(person.enrollmentId)} onSelect={() => setSelected((prior) => prior.includes(person.enrollmentId) ? prior.filter((id) => id !== person.enrollmentId) : [...prior, person.enrollmentId])} />)}
          {rows.length === 0 && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">No people in this group.</TableCell></TableRow>}</TableBody></Table><DataTableFooter><span className="text-sm text-muted-foreground">Showing {rows.length} of {detail.peopleCount} enrollments{detail.peopleCount > 200 ? " (first 200 shown)" : ""}</span></DataTableFooter></DataTableShell>
    </section>
    <Dialog open={copyOpen} onOpenChange={setCopyOpen}><DialogContent><DialogHeader><DialogTitle>Copy steps from another drip</DialogTitle><DialogDescription>Copies text, waits, and order. The source drip stays unchanged. This drip must have no steps.</DialogDescription></DialogHeader>
      <div className="max-h-72 space-y-2 overflow-y-auto">{sources.filter((source) => source.id !== sequence.id && source.step_count > 0).map((source) => <Button key={source.id} variant="outline" className="w-full justify-between" disabled={pending} onClick={() => copy(source.id)}>{source.name}<span>{source.step_count} steps</span></Button>)}{sources.filter((source) => source.id !== sequence.id && source.step_count > 0).length === 0 && <p className="text-sm text-muted-foreground">No drips with steps are available.</p>}</div>
      <DialogFooter><Button variant="outline" onClick={() => setCopyOpen(false)}>Cancel</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={stopOpen} onOpenChange={setStopOpen}><DialogContent><DialogHeader><DialogTitle>Stop drip for {selectedActionable.length} leads?</DialogTitle><DialogDescription>Stopping these enrollments cannot be undone. Other leads in this drip continue.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setStopOpen(false)}>Cancel</Button><Button disabled={pending} onClick={() => run(cancelEnrollment)}>Stop selected</Button></DialogFooter></DialogContent></Dialog>
  </Page>;
}

function PersonRow({ person, stepCount, selected, onSelect }: { person: DripPerson; stepCount: number; selected: boolean; onSelect: () => void }) {
  return <TableRow><TableCell><input type="checkbox" aria-label={`Select ${person.name}`} disabled={!person.canAct} checked={selected} onChange={onSelect} /></TableCell>
    <TableCell><Link href={`/leads/${person.propertyId}`} className="font-medium hover:underline">{person.name}</Link><p className="text-xs text-muted-foreground">{person.address}</p></TableCell>
    <TableCell><span className="rounded-full border px-2 py-1 text-xs">{person.status}</span>{person.detail && <p className="mt-1 text-xs text-muted-foreground">{person.detail}</p>}</TableCell><TableCell>{stepCount ? `${person.step} of ${stepCount}` : "—"}</TableCell><TableCell className="whitespace-nowrap">{dateTime(person.nextRunAt)}</TableCell><TableCell className="text-right whitespace-nowrap">{person.threadId && <Link href={`/messages?thread=${encodeURIComponent(person.threadId)}`} className="mr-3 text-sm underline underline-offset-4">Open thread</Link>}<Link href={`/leads/${person.propertyId}`} className="text-sm underline underline-offset-4">Open lead</Link></TableCell></TableRow>;
}
