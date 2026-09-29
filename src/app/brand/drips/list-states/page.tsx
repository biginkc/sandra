import { Droplet } from "lucide-react";
import Link from "next/link";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { DataTableShell } from "@/components/ui/data-table-shell";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DripsBrandFrame } from "../_frame";

export default function DripsListStates() {
  return <DripsBrandFrame><Page><PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips" }]} title="Drips" description="Follow-up texts that run on a schedule." actions={<Link href="/sequences/new"><Button>New drip</Button></Link>} />
    <section className="space-y-3"><h2 className="text-muted-foreground text-xs font-bold uppercase tracking-widest">Empty — no drips yet</h2>
      <div className="flex items-center gap-7 rounded-2xl border bg-card p-8"><Droplet className="size-10 text-primary" /><div><h3 className="font-medium">No drips yet</h3><p className="text-muted-foreground mb-3 max-w-xl text-sm">A drip is a short set of follow-up texts that stops on its own when a lead replies. Start with one for owners who go quiet.</p><Link href="/sequences/new"><Button>New drip</Button></Link></div></div></section>
    <section className="space-y-3"><h2 className="text-muted-foreground text-xs font-bold uppercase tracking-widest">Loading</h2><DataTableShell><Table><TableHeader><TableRow>{["Drip", "Steps", "Enrolled", "Replied", "Finished, no reply", "Couldn’t send", "Status", "Actions"].map((title) => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader><TableBody>{[0, 1, 2].map((n) => <TableRow key={n}>{Array.from({ length: 8 }, (_, i) => <TableCell key={i}><Skeleton className="h-4 w-full" /></TableCell>)}</TableRow>)}</TableBody></Table><p className="p-3 text-xs text-muted-foreground">Loading drips…</p></DataTableShell></section>
    <section className="space-y-3"><h2 className="text-muted-foreground text-xs font-bold uppercase tracking-widest">Couldn’t load</h2><div role="alert" className="rounded-xl border border-destructive p-4 text-sm text-destructive">We couldn’t load your drips. Nothing was changed. <Link href="/sequences" className="ml-2 underline">Try again</Link></div></section>
    <section className="space-y-3"><h2 className="text-muted-foreground text-xs font-bold uppercase tracking-widest">Archived</h2><Link href="/sequences?archived=1" className="text-sm underline">View archived drips</Link></section>
  </Page></DripsBrandFrame>;
}
