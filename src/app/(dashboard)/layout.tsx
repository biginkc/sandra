import Image from "next/image";
import { recordingViewer } from "@/lib/recordings/data";
import { GlobalSearchProvider } from "@/components/search/global-search-provider";
import { GlobalSearchTrigger } from "@/components/search/global-search-trigger";
import Link from "next/link";
import { redirect } from "next/navigation";

import { SignOutForm } from "@/components/sign-out-form";
import { ConnectionBanner } from "@/components/connection-banner";
import { DashboardAdminNav } from "@/components/dashboard-admin-nav";
import {
  DashboardMobileNav,
  DashboardSidebar,
} from "@/components/dashboard-sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { JobFailureNotifier } from "@/components/job-failure-notifier";
import { NormaConnectedNotifier } from "@/components/norma-connected-notifier";
import { NotificationsBell } from "@/components/notifications-bell";
import { SoftphoneHeaderButton, SoftphoneProvider } from "@/components/softphone/softphone-provider";
import { ObjectionPromptProvider } from "@/components/coach/objection-prompt-context";
import { isObjectionPromptAllowed } from "@/lib/coach/objection-prompt-gate";
import { isAdminEmail } from "@/lib/auth/allowlist";
import { getCallerMemberships } from "@/lib/auth/memberships";
import { canViewMyLeads } from "@/lib/my-leads/access";
import { canViewCalculators } from "@/lib/calculators/access";
import { getAcquisitionBadge, getAcquisitionRoster } from "@/lib/my-leads/queries";
import { canAccessMessagesAndLeadsBoard, isAcquisitionsCaller, shouldRestrictMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import { createClient } from "@/lib/supabase/server";
import { getCallingConfigForCurrentUser } from "@/lib/direct-calling/actions";
import type { CallingConfig } from "@/lib/direct-calling/contract";
import { CallLockProvider } from "@/components/calls/call-lock-context";
import { DialpadCallProvider } from "@/components/dialpad/dialpad-call-provider";
import { getDialpadCallRoute } from "@/lib/dialpad-cti/call-route-server";
import { refreshMyLeadsBadge } from "./my-leads/nav-actions";

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
  const objectionPromptEnabled = isObjectionPromptAllowed(
    process.env.COACH_OBJECTION_PROMPT_ENABLED,
  );
  const showAdmin = isAdminEmail(user.email);
  // A failure here must never block the dashboard; fall back to Jitter.
  const callingConfig: CallingConfig = await getCallingConfigForCurrentUser().catch(
    () => ({ transport: "default" }),
  );
  const recordingAccess = await recordingViewer().catch(() => null);
  const membershipsPromise = getCallerMemberships();
  // Chained off the memberships read so it runs alongside the roster and badge reads, not after them.
  const dialpadRoutePromise = membershipsPromise.then(async (all) => {
    const mine = all.filter((m) => m.user_id === user.id);
    return mine.length === 1
      ? await getDialpadCallRoute(mine[0].org_id, user.id, isAcquisitionsCaller(mine[0]))
      : "softphone";
  });
  const [rosterResult, badgeResult, surfaceMembershipsResult, dialpadRouteResult] = await Promise.allSettled([
    getAcquisitionRoster(),
    getAcquisitionBadge(),
    membershipsPromise,
    dialpadRoutePromise,
  ]);
  const acquisitionRoster =
    rosterResult.status === "fulfilled" ? rosterResult.value : null;
  const restrictedAcquisitionMember =
    surfaceMembershipsResult.status === "fulfilled" &&
    shouldRestrictMessagesAndLeadsBoard(surfaceMembershipsResult.value);
  const showMyLeads = Boolean(
    restrictedAcquisitionMember || (acquisitionRoster &&
      canViewMyLeads(acquisitionRoster.roster, acquisitionRoster.viewer.userId, acquisitionRoster.viewer.isOwner)),
  );
  const initialAcquisitionBadge =
    showMyLeads && badgeResult.status === "fulfilled" ? badgeResult.value : null;
  const showCalculators = Boolean(acquisitionRoster && canViewCalculators(
    acquisitionRoster.roster,
    acquisitionRoster.viewer.userId,
    acquisitionRoster.viewer.isOwner,
  ));
  const showMessagesAndLeads =
    surfaceMembershipsResult.status === "fulfilled" &&
    canAccessMessagesAndLeadsBoard(surfaceMembershipsResult.value);

  // Where every Call button sends the call: server-derived, never from the browser.
  const dialpadCallsEnabled = dialpadRouteResult.status === "fulfilled" && dialpadRouteResult.value === "dialpad";

  return (
    <ObjectionPromptProvider enabled={objectionPromptEnabled}>
    <CallLockProvider>
    <SoftphoneProvider callingConfig={callingConfig}>
    <DialpadCallProvider enabled={dialpadCallsEnabled}>
    <GlobalSearchProvider>
    <div className="bg-background min-h-screen">
      <ConnectionBanner />
      <JobFailureNotifier />
      <NormaConnectedNotifier />

      <header className="nav-field fixed inset-x-0 top-0 left-0 z-40 flex h-16 items-center justify-between gap-3 border-b border-white/10 px-4 md:left-64 md:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/dashboard"
            className="md:hidden"
            aria-label="Sandra dashboard home"
          >
            <Image
              src="/brand/sandra-logo-home.svg"
              alt="Sandra"
              width={104}
              height={32}
              className="h-8 w-auto object-contain"
              priority
            />
          </Link>
          <DashboardAdminNav showAdmin={showAdmin} />
        </div>
        <div className="flex min-w-0 items-center gap-[14px] text-sm [&>*:not(:first-child)]:shrink-0">
          {/* The provider keeps this client control mounted across route changes. */}
          <GlobalSearchTrigger />
          <SoftphoneHeaderButton />
          <NotificationsBell userId={user.id} />
          <SignOutForm />
        </div>
      </header>

      <aside className="nav-field fixed inset-y-0 left-0 z-30 hidden w-64 flex-col md:flex">
        <Link
          href="/dashboard"
          className="mb-4 flex items-center justify-center px-5 pt-5 pb-3"
        >
          <Image
            src="/brand/sandra-logo-home.svg"
            alt="Sandra"
            width={152}
            height={154}
            className="h-auto w-[152px] object-contain"
            priority
          />
        </Link>
        <DashboardSidebar
          showCalculators={showCalculators}
          showMessagesAndLeads={showMessagesAndLeads}
          showMyLeads={showMyLeads}
          showRecordings={recordingAccess?.owner}
          showMyRecordings={recordingAccess?.mine}
          initialAcquisitionBadge={initialAcquisitionBadge}
          onRefreshAcquisitionBadge={refreshMyLeadsBadge}
        />
        <div
          className="mx-6 mt-2 border-t border-white/10 pt-3 text-xs text-white/75"
          title={user.email ?? ""}
        >
          <span className="block truncate">{user.email}</span>
        </div>
      </aside>

      <div className="nav-field fixed inset-x-0 top-16 z-30 border-b border-white/10 md:hidden">
        <DashboardMobileNav
          showCalculators={showCalculators}
          showMessagesAndLeads={showMessagesAndLeads}
          showMyLeads={showMyLeads}
          showRecordings={recordingAccess?.owner}
          showMyRecordings={recordingAccess?.mine}
          initialAcquisitionBadge={initialAcquisitionBadge}
          onRefreshAcquisitionBadge={refreshMyLeadsBadge}
        />
      </div>

      <div className="flex flex-col pt-[116px] md:pt-16 md:ml-64">
        <main className="flex flex-1 flex-col">
          <ErrorBoundary surface="dashboard">{children}</ErrorBoundary>
        </main>
      </div>
    </div>
    </GlobalSearchProvider>
    </DialpadCallProvider>
    </SoftphoneProvider>
    </CallLockProvider>
    </ObjectionPromptProvider>
  );
}
