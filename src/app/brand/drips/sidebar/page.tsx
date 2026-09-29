import Image from "next/image";

import { DashboardSidebar } from "@/components/dashboard-sidebar";
import { PageHeader } from "@/components/page-header";

import { dripBrandFixture } from "../_fixtures";

export default function DripsSidebarBrandPage() {
  return (
    <div className="flex min-h-screen" data-testid="drips-brand-sidebar">
      <aside className="nav-field flex w-64 shrink-0 flex-col" data-testid="sidebar-crop">
        <div className="mb-4 flex items-center justify-center px-5 pt-5 pb-3">
          <Image src="/brand/sandra-logo-home.svg" alt="Sandra" width={152} height={154} className="h-auto w-[152px] object-contain" />
        </div>
        <DashboardSidebar activePathname="/sequences" showCalculators showMyLeads showRecordings />
      </aside>
      <section className="flex-1 p-8">
        <PageHeader
          breadcrumb={[{ label: "Workspace" }, { label: dripBrandFixture.title }]}
          title={dripBrandFixture.title}
          description={dripBrandFixture.description}
        />
      </section>
    </div>
  );
}
