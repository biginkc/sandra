import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { getCallerMembershipsOrThrow, type Membership } from "@/lib/auth/memberships";
import { canViewMyLeads } from "@/lib/my-leads/access";
import { CALL_FEATURES_OFF, getMyLeadsCallFeatures } from "@/lib/my-leads/call-features";
import { getMyLeadsFlag } from "@/lib/my-leads/flags";
import { getAcquisitionRoster } from "@/lib/my-leads/queries";
import { MY_LEAD_ROW_REASON_COPY } from "@/lib/my-leads/row-reasons";

import { CallScreen } from "./call-screen";
import { loadCallScreen } from "./loaders";

export const dynamic = "force-dynamic";
// Server actions on this page inherit the limit (maxDuration.md "Server Actions"); the 3c contract
// send needs the 4-minute provider abort plus the outcome write.
export const maxDuration = 300;

function unavailableState(message: string) {
  return (
    <Page>
      <PageHeader title="Call screen" />
      <div role="alert" className="text-destructive text-sm">
        <span>{message} </span>
        <a href="/my-leads" className="font-bold underline underline-offset-4">Back to My Leads</a>
      </div>
    </Page>
  );
}

/**
 * TECH-PLAN §3.10. The screen is the signed-in user's own queue only (a URL never grants access).
 * Renders only when the org's `call_screen` flag is on (a missing row reads OFF); otherwise 404 (as for
 * any membership or roster failure), so the route is inert until the operator turns it on.
 */
export default async function CallScreenPage({ params }: { params: Promise<{ propertyId: string }> }) {
  const { propertyId } = await params;

  let memberships: Membership[];
  try {
    memberships = await getCallerMembershipsOrThrow();
  } catch {
    notFound();
  }
  if (memberships.length !== 1) notFound();

  let viewer: Awaited<ReturnType<typeof getAcquisitionRoster>>["viewer"];
  let roster: Awaited<ReturnType<typeof getAcquisitionRoster>>["roster"];
  try {
    ({ viewer, roster } = await getAcquisitionRoster());
  } catch {
    notFound();
  }
  if (!roster.settings.enabled || !canViewMyLeads(roster, viewer.userId, viewer.isOwner)) notFound();

  // Only the new screen is gated by its flag. The numbers card degrades on its own when the
  // lead_comps schema is not ready, and the actions that need it check readiness themselves.
  if (!(await getMyLeadsFlag(viewer.orgId, "call_screen"))) notFound();

  const load = await loadCallScreen(propertyId);
  if (load.status === "invalid") notFound();
  if (load.status === "unavailable") return unavailableState(MY_LEAD_ROW_REASON_COPY[load.reason]);
  if (load.status === "error") return unavailableState(load.message);

  // click_to_dial flag AND schemaReady('api_dial'), the same gate the My Leads page uses; off keeps Call disabled.
  const { clickToDial } = await getMyLeadsCallFeatures(viewer.orgId).catch(() => CALL_FEATURES_OFF);
  const viewerLabel = roster.members.find((m) => m.id === viewer.userId)?.label ?? null;
  return (
    <Page className="gap-4">
      <CallScreen data={load.data} viewerLabel={viewerLabel} clickToDial={clickToDial} />
    </Page>
  );
}
