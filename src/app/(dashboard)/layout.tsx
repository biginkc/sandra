import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { ConnectionBanner } from "@/components/connection-banner";
import {
  DashboardMobileNav,
  DashboardSidebar,
} from "@/components/dashboard-sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { JobFailureNotifier } from "@/components/job-failure-notifier";
import { NotificationsBell } from "@/components/notifications-bell";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { createClient } from "@/lib/supabase/server";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const showAdmin = isAdminEmail(user.email);

  return (
    <div className="bg-background min-h-screen">
      <ConnectionBanner />
      <JobFailureNotifier />

      <header className="nav-field fixed inset-x-0 top-0 left-0 z-40 flex h-16 items-center justify-between border-b border-white/10 px-4 md:left-64 md:justify-end md:px-7">
        <Link
          href="/dashboard"
          className="md:hidden"
          aria-label="Sandra dashboard home"
        >
          <Image
            src="/brand/sandra-logo-home.svg"
            alt="Sandra"
            width={120}
            height={36}
            className="h-9 w-auto"
            priority
          />
        </Link>
        <div className="flex items-center gap-[14px] text-sm">
          <NotificationsBell userId={user.id} />
          <form action="/auth/signout" method="post" className="border-l border-white/10">
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className="h-auto rounded-lg px-[14px] py-[7px] pl-4 text-sm font-semibold text-white hover:bg-white/[0.07] hover:text-white"
            >
              Sign out
            </Button>
          </form>
        </div>
      </header>

      <aside className="nav-field fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-white/10 md:flex">
        <Link
          href="/dashboard"
          className="mb-[14px] flex items-center justify-center border-b border-white/10 px-5 pt-[22px] pb-5"
        >
          <Image
            src="/brand/sandra-logo-home.svg"
            alt="Sandra"
            width={176}
            height={178}
            className="h-auto w-44"
            priority
          />
        </Link>
        <DashboardSidebar showAdmin={showAdmin} />
        <div
          className="mx-6 mt-2 border-t border-white/10 pt-3 text-xs text-white/75"
          title={user.email ?? ""}
        >
          <span className="block truncate">{user.email}</span>
        </div>
      </aside>

      <div aria-hidden="true" className="glow-v hidden md:block" />
      <div aria-hidden="true" className="glow-h hidden md:block" />

      <div className="nav-field fixed inset-x-0 top-16 z-30 border-b border-white/10 md:hidden">
        <DashboardMobileNav showAdmin={showAdmin} />
      </div>

      <div className="flex flex-col pt-[116px] md:pt-16 md:ml-64">
        <main className="flex flex-1 flex-col">
          <ErrorBoundary surface="dashboard">{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
