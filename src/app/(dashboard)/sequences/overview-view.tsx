import Link from "next/link";
import { Droplet, Plus } from "lucide-react";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DataTableFooter, DataTableShell } from "@/components/ui/data-table-shell";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Result } from "@/lib/errors/result";
import type { NeedsPersonCounts, SequenceRow } from "./actions";
import { SequenceRowActions } from "./row-actions";

export function DripsOverview({ archived, isAdmin, sequencesResult, needsResult }: {
  archived: boolean;
  isAdmin: boolean;
  sequencesResult: Result<SequenceRow[]>;
  needsResult: Result<NeedsPersonCounts>;
}) {
  const sequences = sequencesResult.ok ? sequencesResult.data : [];
  const rows = sequences.filter((row) => archived ? !!row.archived_at : !row.archived_at);
  const totals = needsResult.ok ? needsResult.data : { finished_no_reply: 0, couldnt_send: 0, needs_sequence: 0 };

  return <Page>
    <PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips" }]} title="Drips" description="Follow-up texts that run on a schedule."
      actions={isAdmin ? <Link href="/sequences/new"><Button><Plus className="size-4" /> New drip</Button></Link> : undefined} />
    <div className="grid gap-3 md:grid-cols-3" aria-label="Drip overview">
      {([
        ["Finished, no reply", totals.finished_no_reply, "/sequences/needs-person#finished-no-reply"],
        ["Texts couldn’t send", totals.couldnt_send, "/sequences/needs-person#couldnt-send"],
        ["Needs a drip, none picked yet", totals.needs_sequence, "/sequences/needs-person#needs-drip"],
      ] as const).map(([label, count, href]) => <Link key={label} href={href} className="rounded-2xl border bg-card p-5 hover:border-primary/50">
        <span className="text-muted-foreground text-sm">{label}</span><strong className="mt-2 block font-heading text-3xl">{count}</strong>
      </Link>)}
    </div>
    {!sequencesResult.ok && <div role="alert" className="rounded-xl border border-destructive p-4 text-destructive text-sm">Could not load drips: {sequencesResult.error.message} <Link href="/sequences" className="ml-2 underline">Try again</Link></div>}
    {!needsResult.ok && <p role="alert" className="text-destructive text-sm">Could not load needs-person counts: {needsResult.error.message}</p>}
    <div className="flex items-center justify-between gap-3"><h2 className="font-heading text-xl">{archived ? "Archived drips" : "Your drips"}</h2>
      <Link href={archived ? "/sequences" : "/sequences?archived=1"} className="text-sm underline underline-offset-4">{archived ? "View current drips" : "View archived"}</Link></div>
    {sequencesResult.ok && rows.length === 0 && <div className="flex items-center gap-6 rounded-2xl border bg-card p-8"><Droplet className="size-10 shrink-0 text-primary" /><div>
      <h3 className="font-medium">{archived ? "No archived drips." : isAdmin ? "No drips yet. Create one to get started." : "No drips are available yet."}</h3>
      {!archived && <p className="text-muted-foreground mt-1 mb-3 max-w-xl text-sm">A drip is a short set of follow-up texts that stops when a lead replies.</p>}
      {!archived && isAdmin && <Link href="/sequences/new"><Button size="sm">New drip</Button></Link>}
    </div></div>}
    {sequencesResult.ok && rows.length > 0 && <DataTableShell data-testid="drips-table"><Table className="[&_th]:px-3 [&_td]:px-3"><TableHeader><TableRow>
      <TableHead>Drip</TableHead><TableHead>Steps</TableHead><TableHead>Enrolled</TableHead><TableHead>Replied</TableHead>
      <TableHead>Finished, no reply</TableHead><TableHead>Couldn’t send</TableHead><TableHead>Status</TableHead><TableHead className="text-right">Actions</TableHead>
    </TableRow></TableHeader><TableBody>
      {rows.map((row) => <TableRow key={row.id}>
        <TableCell><div className="flex items-center gap-2"><Droplet className="size-4 text-primary" /><div><Link href={`/sequences/${row.id}`} className="font-medium hover:underline">{row.name}</Link>{row.description && <p className="text-muted-foreground max-w-64 truncate text-xs">{row.description}</p>}</div></div></TableCell>
        <TableCell>{row.step_count}</TableCell><TableCell>{row.active_enrollment_count}</TableCell><TableCell>{row.replied ?? 0}</TableCell><TableCell>{row.finished_no_reply ?? 0}</TableCell><TableCell>{row.couldnt_send ?? 0}</TableCell>
        <TableCell><span title={row.archived_at ? "Archived" : row.active ? "Open to new leads" : "Closed to new leads"}>{row.archived_at ? "Archived" : row.active ? "Open" : "Closed"}</span></TableCell>
        <TableCell className="text-right">{isAdmin && <SequenceRowActions sequenceId={row.id} isArchived={!!row.archived_at} isActive={row.active} />}</TableCell>
      </TableRow>)}
    </TableBody></Table><DataTableFooter><span className="text-sm text-muted-foreground">Showing {rows.length} {archived ? "archived" : "current"} {rows.length === 1 ? "drip" : "drips"}</span></DataTableFooter></DataTableShell>}
  </Page>;
}
