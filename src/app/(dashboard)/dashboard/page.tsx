import { redirect } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { EMPTY_SENDILLO_SMS_HEALTH } from "@/lib/messages/sendillo-health";
import { getStoredSkipTraceBalance } from "@/lib/skip-trace/balance";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { ActivityFeed } from "./_components/activity-feed";
import { KpiRowOne, KpiRowTwo } from "./_components/kpi-cards";
import { NeedsAttentionStrip } from "./_components/needs-attention-strip";
import { QuickActions } from "./_components/quick-actions";
import { SendilloHealthCard } from "./_components/sendillo-health-card";
import { SkipTraceCredits } from "./_components/skip-trace-credits";
import { TasksPanel } from "./_components/tasks-panel";
import { ThreadsNeedingAttention } from "./_components/threads-needing-attention";
import {
  fetchDashboardSendilloSmsHealth,
  fetchDashboardSummary,
  fetchMyTasks,
} from "./queries";

export const metadata = {
  title: "Overview · Sandra CRM",
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const requestNow = new Date();
  const nowMs = requestNow.getTime();
  const memberships = await getCallerMemberships();
  // Fail closed for aggregate/provider visibility: only an actual owner
  // membership unlocks organization KPIs and provider health. The email
  // allowlist remains a separate capability check for admin-only actions.
  const callerMemberships = memberships.filter(
    (membership) => membership.user_id === user.id,
  );
  const isOwner =
    callerMemberships.length === 1 && callerMemberships[0].role === "owner";

  // listUsers() always fetches the whole team; it has no assignee-id filter.
  // Start it with the dashboard data and filter the result after the batch.
  const ownerHealthPromise = isOwner
    ? (async () => {
        const [balance, sendilloSmsHealth, assigneeUsers] = await Promise.all([
          getStoredSkipTraceBalance(supabase).catch(
            () => ({ available: false, reason: "read_error" }) as const,
          ),
          fetchDashboardSendilloSmsHealth().catch(
            () =>
              ({
                status: "unavailable",
                health: EMPTY_SENDILLO_SMS_HEALTH,
                message: "Provider health could not load.",
              }) as const,
          ),
          createAdminClient()
            .auth.admin.listUsers({ perPage: 200 })
            .then((result) => result.data?.users ?? [])
            .catch(() => []),
        ]);
        return {
          balance,
          sendilloSmsHealth,
          assigneeUsers,
        };
      })()
    : Promise.resolve(null);

  const [summary, myTasks, ownerHealth] = await Promise.all([
    fetchDashboardSummary(),
    fetchMyTasks(user.id, requestNow),
    ownerHealthPromise,
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
            Could not load dashboard data. Retry this request — if the problem
            persists, check the server logs.
          </p>
          <a
            href="/dashboard"
            className="bg-primary text-primary-foreground mt-4 inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-semibold"
            data-testid="overview-summary-retry"
          >
            Retry
          </a>
        </div>
      </Page>
    );
  }

  const isAdmin = isAdminEmail(user.email);
  const greeting = greet(user.email, requestNow, myTasks.timezone);
  const today = requestNow.toLocaleDateString("en-US", {
    timeZone: myTasks.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const escalatedTotal = summary.needs_attention.escalated_unhandled;

  // Resolve assignee user_ids → emails via the admin client (same pattern
  // /leads uses). The RPC can't reach auth.users under security invoker.
  const assigneeEmails: Record<string, string> = {};
  const assigneeIds = new Set(summary.assigned.map((a) => a.user_id));
  for (const u of ownerHealth?.assigneeUsers ?? []) {
    if (u.email && assigneeIds.has(u.id)) {
      assigneeEmails[u.id] = u.email;
    }
  }

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Overview" }]}
        title={greeting}
        description={today}
      />

      <div className="space-y-6">
        <section
          aria-label="Today's work"
          className="space-y-6"
          data-testid="overview-daily-work"
        >
          <NeedsAttentionStrip needs={summary.needs_attention} />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start">
            <TasksPanel {...myTasks} currentUserId={user.id} nowMs={nowMs} />
            <ThreadsNeedingAttention
              threads={summary.threads_needing_attention}
              totalCount={escalatedTotal}
              nowMs={nowMs}
            />
          </div>
        </section>

        {isOwner && ownerHealth ? (
          <section
            aria-label="Business and system health"
            className="space-y-6"
            data-testid="overview-business-health"
          >
            <KpiRowOne
              totalLeads={summary.total_leads}
              newThisWeek={summary.new_this_week}
              notInDrip={summary.not_in_drip}
              assigned={summary.assigned}
              assigneeEmails={assigneeEmails}
              currentUserId={user.id}
            />
            <KpiRowTwo summary={summary} currentUserId={user.id} />
            <SkipTraceCredits balance={ownerHealth.balance} isAdmin={isAdmin} />
            <SendilloHealthCard result={ownerHealth.sendilloSmsHealth} />
          </section>
        ) : null}

        <section aria-label="Workspace activity" className="space-y-6">
          <QuickActions isAdmin={isAdmin} />
          <ActivityFeed events={summary.recent_activity} />
        </section>
      </div>
    </Page>
  );
}

function greet(
  email: string | null | undefined,
  now: Date,
  timeZone: string,
): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .find((part) => part.type === "hour")?.value ?? "0",
  );
  const period = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  if (!email) return `Good ${period}`;
  const local = email.split("@")[0] ?? "";
  const cleaned = local.replace(/[._-]+/g, " ").trim();
  if (!cleaned) return `Good ${period}`;
  const first = cleaned.split(" ")[0];
  const name = first.charAt(0).toUpperCase() + first.slice(1);
  return `Good ${period}, ${name}`;
}
