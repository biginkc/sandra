import Link from "next/link";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { DripsBrandFrame } from "../_frame";

export default function BrandDripDetailError() {
  return <DripsBrandFrame><Page><PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }]} title="Drip unavailable" />
    <div role="alert" className="rounded-xl border border-destructive p-4 text-destructive">We couldn’t load this drip. Existing texts may still be going out. <Link href="/sequences" className="ml-2 underline">Try again</Link></div></Page></DripsBrandFrame>;
}
