import { notFound } from "next/navigation";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getSequenceAdminStatus } from "../admin";
import { listSequences } from "../actions";
import { getDripDetail } from "./detail-data";
import { DripDetailView } from "./detail-view";

export default async function DripDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [detail, sources, isAdmin] = await Promise.all([getDripDetail(id), listSequences(), getSequenceAdminStatus()]);
  if (detail.ok && !detail.data) notFound();
  if (!detail.ok) return <Page><PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Drips", href: "/sequences" }]} title="Drip unavailable" /><div role="alert" className="rounded-xl border border-destructive p-4 text-destructive">We couldn’t load this drip. Existing texts may still be going out. {detail.error.message} <a href={`/sequences/${id}`} className="ml-2 underline">Try again</a></div></Page>;
  return <DripDetailView detail={detail.data!} sources={sources.ok ? sources.data : []} isAdmin={isAdmin} />;
}
