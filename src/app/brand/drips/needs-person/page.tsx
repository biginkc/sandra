import { NeedsPersonBoard } from "@/app/(dashboard)/sequences/needs-person/board";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import Link from "next/link";
import { DripsBrandFrame } from "../_frame";
import { sampleNeedsLeads } from "../_sample";

export default function BrandNeedsPerson() {
  return <DripsBrandFrame><Page><PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips" }, { label: "Needs a person" }]} title="Needs a person" description="Leads that need a human follow-up or a drip." actions={<Link href="/sequences" className="text-sm underline">Back to drips</Link>} /><NeedsPersonBoard rows={sampleNeedsLeads} /></Page></DripsBrandFrame>;
}
