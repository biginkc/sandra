import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ConnectionBanner } from "@/components/connection-banner";
import { DashboardSidebar } from "@/components/dashboard-sidebar";
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
    <div className="flex min-h-screen">
      <ConnectionBanner />
      <JobFailureNotifier />

      {/* Left sidebar — fixed width, always visible on ≥md screens. On
          smaller screens it collapses to a thin stripe; primary user is
          on desktop today so this is the honest tradeoff. */}
      <aside className="border-border bg-muted/30 sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r md:flex">
        <div className="border-border flex items-center gap-2 border-b px-4 py-3">
          <Link href="/properties" className="font-semibold">
            Sandra CRM
          </Link>
        </div>
        <DashboardSidebar showAdmin={showAdmin} />
        <div className="border-border flex items-center gap-2 border-t px-4 py-3 text-xs">
          <span className="text-muted-foreground truncate" title={user.email ?? ""}>
            {user.email}
          </span>
        </div>
      </aside>

      {/* Main column — header + content. Header only carries items that
          stay top-right: bell, sign-out. */}
      <div className="flex flex-1 flex-col">
        <header className="border-border flex items-center justify-between gap-3 border-b px-6 py-2 text-sm md:justify-end">
          {/* Mobile-only brand mark since the sidebar is hidden there. */}
          <Link
            href="/properties"
            className="font-semibold md:hidden"
          >
            Sandra CRM
          </Link>
          <div className="flex items-center gap-3">
            <NotificationsBell userId={user.id} />
            <Separator orientation="vertical" className="hidden h-5 md:block" />
            <form action="/auth/signout" method="post">
              <Button type="submit" variant="ghost" size="sm">
                Sign out
              </Button>
            </form>
          </div>
        </header>
        <main className="flex flex-1 flex-col">
          <ErrorBoundary surface="dashboard">{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
