import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { listNeedsPersonLeads } from "./actions";
import { NeedsPersonBoard } from "./board";

export default async function NeedsPersonPage() {
  const result = await listNeedsPersonLeads();
  return <Page>
    <PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }, { label: "Needs a person" }]}
      title="Needs a person" description="Leads that need a human follow-up or a drip." actions={<Link href="/sequences" className="text-sm underline">Back to drips</Link>} />
    {result.ok ? <NeedsPersonBoard rows={result.data} /> : <p role="alert" className="text-destructive">Could not load leads: {result.error.message}</p>}
  </Page>;
}
