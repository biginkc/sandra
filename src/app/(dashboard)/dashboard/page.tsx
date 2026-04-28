import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getSkipTraceBalance } from "@/lib/skip-trace/balance";
import { createClient } from "@/lib/supabase/server";

import { ActivityFeed } from "./_components/activity-feed";
import { KpiRowOne, KpiRowTwo } from "./_components/kpi-cards";
import { NeedsAttentionStrip } from "./_components/needs-attention-strip";
import { QuickActions } from "./_components/quick-actions";
import { SkipTraceCredits } from "./_components/skip-trace-credits";
import { ThreadsNeedingAttention } from "./_components/threads-needing-attention";
import { fetchDashboardSummary } from "./queries";

export const metadata = {
  title: "Overview · Sandra CRM",
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const [summary, balance] = await Promise.all([
    fetchDashboardSummary(),
    getSkipTraceBalance(),
  ]);

  if (!summary) {
    return (
      <Page>
        <PageHeader
          breadcrumb={[{ label: "Workspace" }, { label: "Overview" }]}
          title="Overview"
        />
        <div className="border-border bg-card rounded-2xl border px-6 py-8 text-center">
          <p className="text-muted-foreground text-sm">
            Could not load dashboard data. Try refreshing — if the problem
            persists, check the server logs.
          </p>
        </div>
      </Page>
    );
  }

  const greeting = greet(user.email);
  // Server components render once per request; capturing request time here
  // is intentional and stable for the duration of the response.
  // eslint-disable-next-line react-hooks/purity
  const nowMs = Date.now();
  const today = new Date(nowMs).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const escalatedTotal = summary.needs_attention.escalated_unhandled;

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Overview" }]}
        title={greeting}
        description={today}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_340px]">
        {/* Main column */}
        <div className="space-y-6">
          <SkipTraceCredits balance={balance} />
          <NeedsAttentionStrip needs={summary.needs_attention} />
          <KpiRowOne
            totalLeads={summary.total_leads}
            newThisWeek={summary.new_this_week}
            notInDrip={summary.not_in_drip}
            assigned={summary.assigned}
            currentUserId={user.id}
          />
          <KpiRowTwo summary={summary} currentUserId={user.id} />
          <QuickActions />
        </div>

        {/* Right rail */}
        <div className="space-y-6">
          <ThreadsNeedingAttention
            threads={summary.threads_needing_attention}
            totalCount={escalatedTotal}
            nowMs={nowMs}
          />
          <ActivityFeed events={summary.recent_activity} />
        </div>
      </div>
    </Page>
  );
}

function greet(email: string | null | undefined): string {
  const hour = new Date().getHours();
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  if (!email) return `Good ${period}`;
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  if (!cleaned) return `Good ${period}`;
  const first = cleaned.split(" ")[0];
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  return `Good ${period}, ${name}`;
}
