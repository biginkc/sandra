import Link from "next/link";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ConnectionBanner } from "@/components/connection-banner";
import { ErrorBoundary } from "@/components/error-boundary";
import { JobFailureNotifier } from "@/components/job-failure-notifier";
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
    <div className="flex min-h-screen flex-col">
      <ConnectionBanner />
      <JobFailureNotifier />
      <header className="border-border flex items-center gap-6 border-b px-6 py-3">
        <Link href="/properties" className="font-semibold">
          Sandra CRM
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link
            href="/leads"
            className="text-muted-foreground hover:text-foreground"
          >
            Leads
          </Link>
          <Link
            href="/properties"
            className="text-muted-foreground hover:text-foreground"
          >
            Prospects
          </Link>
          <Link
            href="/lists"
            className="text-muted-foreground hover:text-foreground"
          >
            Lists
          </Link>
          <Link
            href="/import"
            className="text-muted-foreground hover:text-foreground"
          >
            Import
          </Link>
          <Link
            href="/messages"
            className="text-muted-foreground hover:text-foreground"
          >
            Messages
          </Link>
          <Link
            href="/jobs"
            className="text-muted-foreground hover:text-foreground"
          >
            Jobs
          </Link>
          {showAdmin ? (
            <Link
              href="/admin/users"
              className="text-muted-foreground hover:text-foreground"
            >
              Team
            </Link>
          ) : null}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">{user.email}</span>
          <Separator orientation="vertical" className="h-5" />
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
  );
}
