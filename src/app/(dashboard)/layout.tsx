import { Workflow } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
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
    <div className="bg-background min-h-screen">
      <ConnectionBanner />
      <JobFailureNotifier />

      {/* Fixed top bar — bell + sign-out only on desktop (the sidebar
          owns brand). Starts at `left-64` on md+ so the sidebar's brand
          block can sit flush at the top instead of being pushed down by
          a 64px header overlay. */}
      <header className="border-border bg-background fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between border-b px-6 md:left-64 md:justify-end md:px-6">
        <Link
          href="/properties"
          className="text-foreground text-lg font-black tracking-tight uppercase md:hidden"
        >
          Sandra
        </Link>
        <div className="flex items-center gap-1 text-sm">
          <NotificationsBell userId={user.id} />
          <form action="/auth/signout" method="post">
            <Button type="submit" variant="ghost" size="sm">
              Sign out
            </Button>
          </form>
        </div>
      </header>

      {/* Fixed left rail — brand block + primary nav + user-email footer.
          Brand sits flush at top because the header no longer overlays
          the sidebar on md+. */}
      <aside className="border-border bg-background fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r md:flex">
        <Link
          href="/properties"
          className="mt-6 mb-6 flex items-center gap-3 px-6"
        >
          <div className="bg-primary flex size-10 items-center justify-center rounded-xl">
            <Workflow className="text-primary-foreground size-5" />
          </div>
          <div className="flex flex-col">
            <span className="text-foreground text-lg font-black tracking-wide">
              Sandra CRM
            </span>
            <span className="text-muted-foreground text-[10px] font-bold tracking-widest uppercase">
              Wholesale Suite
            </span>
          </div>
        </Link>
        <DashboardSidebar showAdmin={showAdmin} />
        <div
          className="border-border mx-6 mt-2 border-t pt-3 text-xs"
          title={user.email ?? ""}
        >
          <span className="text-muted-foreground block truncate">
            {user.email}
          </span>
        </div>
      </aside>

      {/* Main column — generous padding to match the mockup. Top offset
          clears the fixed header; left margin clears the fixed rail on
          ≥md. On smaller screens the rail collapses and the page sits
          flush against the left edge. */}
      <div className="flex flex-col pt-16 md:ml-64">
        <main className="flex flex-1 flex-col">
          <ErrorBoundary surface="dashboard">{children}</ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
