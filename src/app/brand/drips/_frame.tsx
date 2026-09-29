import Image from "next/image";
import type { ReactNode } from "react";
import { DashboardSidebar } from "@/components/dashboard-sidebar";

export function DripsBrandFrame({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen bg-background">
    <aside className="nav-field flex w-64 shrink-0 flex-col"><div className="mb-4 flex items-center justify-center px-5 pt-5 pb-3"><Image src="/brand/sandra-logo-home.svg" alt="Sandra" width={152} height={154} className="h-auto w-[152px] object-contain" /></div>
      <DashboardSidebar activePathname="/sequences" showCalculators showMyLeads showRecordings />
    </aside><div className="min-w-0 flex-1 p-8">{children}</div>
  </div>;
}
