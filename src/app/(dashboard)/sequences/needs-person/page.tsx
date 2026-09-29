import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { listNeedsPersonLeads } from "./actions";
import { NeedsPersonBoard } from "./board";
import { listSequenceNeedsPersonCounts, type NeedsPersonBucket } from "../actions";

const BUCKETS = ["finished_no_reply", "couldnt_send", "needs_sequence"] as const satisfies readonly NeedsPersonBucket[];

function pageNumber(value: string | undefined) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 1_000_000 ? number : 1;
}

export default async function NeedsPersonPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const pages = Object.fromEntries(BUCKETS.map((bucket) => [bucket, pageNumber(params[bucket])])) as Record<NeedsPersonBucket, number>;
  const [counts, ...results] = await Promise.all([
    listSequenceNeedsPersonCounts(),
    ...BUCKETS.map((bucket) => listNeedsPersonLeads(bucket, pages[bucket])),
  ]);
  const error = !counts.ok ? counts.error : results.find((result) => !result.ok)?.error;
  const rows = results.flatMap((result) => result.ok ? result.data : []);
  return <Page>
    <PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }, { label: "Needs a person" }]}
      title="Needs a person" description="Leads that need a human follow-up or a drip." actions={<Link href="/sequences" className="text-sm underline">Back to drips</Link>} />
    {counts.ok && !error ? <NeedsPersonBoard key={JSON.stringify(pages)} rows={rows} counts={counts.data} pages={pages} openGroups={params.open} /> : <p role="alert" className="text-destructive">Could not load leads: {error?.message}</p>}
  </Page>;
}
