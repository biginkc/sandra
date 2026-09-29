import type { ReactNode } from "react";
import Image from "next/image";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { PageHeader } from "@/components/page-header";

export function DripPreviewShell({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return <div className="flex min-h-screen bg-[#f9f8f6]">
    <aside className="nav-field w-60 shrink-0 p-4"><div className="mb-5 flex justify-center"><Image src="/brand/sandra-logo-home.svg" alt="Sandra" width={124} height={125} className="h-24 w-auto object-contain" /></div><DashboardSidebar activePathname="/leads" showCalculators showMyLeads showRecordings /></aside>
    <div className="min-w-0 flex-1"><div className="flex items-center justify-between bg-[#152340] px-8 py-3 text-xs text-white"><div className="flex gap-6"><span>Team</span><span>Webhooks</span><span>AI responder</span></div><div>Search properties, owners, texts</div></div><div className="p-6"><PageHeader breadcrumb={[{ label: "Workspace" }, { label: "Leads" }]} title={title} description={description} actions={actions} />{children}</div></div>
  </div>;
}
