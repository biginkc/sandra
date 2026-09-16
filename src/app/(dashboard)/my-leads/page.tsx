import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import {
  getCallerMembershipsOrThrow,
  type Membership,
} from "@/lib/auth/memberships";
import { shouldRestrictMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import { canViewMyLeads } from "@/lib/my-leads/access";
import {
  getAcquisitionKpis,
  getAcquisitionQueue,
  getAcquisitionRoster,
  MyLeadsReadError,
} from "@/lib/my-leads/queries";

import { MyLeadsClient } from "./client";

function unavailableState() {
  return (
    <Page>
      <PageHeader title="My Leads" />
      <div role="alert" className="text-destructive text-sm">
        <span>My Leads is temporarily unavailable. </span>
        {/* Reload the document so Retry reruns the failed server reads even on this same URL. */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/my-leads" className="font-bold underline underline-offset-4">
          Retry
        </a>
      </div>
    </Page>
  );
}

function disabledState() {
  return (
    <Page>
      <PageHeader title="My Leads" />
      <p role="status" className="text-muted-foreground text-sm">
        My Leads is disabled for this organization.
      </p>
    </Page>
  );
}

function isFeatureDisabled(error: unknown): boolean {
  if (error instanceof MyLeadsReadError) {
    return error.code === "FEATURE_DISABLED";
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "FEATURE_DISABLED"
  );
}

function loadFailureState(error: unknown) {
  // Only expose the stable rollout state. All transport, database, and
  // authorization failures use the same retryable message so internal
  // details cannot reach the page.
  return isFeatureDisabled(error) ? disabledState() : unavailableState();
}

export default async function MyLeadsPage() {
  let memberships: Membership[];
  try {
    memberships = await getCallerMembershipsOrThrow();
  } catch (error) {
    return loadFailureState(error);
  }

  // `getAcquisitionRoster` also requires one active organization. Resolve
  // that boundary before the roster call so a missing or ambiguous scope is
  // an explicit unavailable state rather than an accidental 404 or 500.
  if (memberships.length !== 1) return unavailableState();

  const isRestrictedAcquisitionMember =
    shouldRestrictMessagesAndLeadsBoard(memberships);

  let viewer: Awaited<ReturnType<typeof getAcquisitionRoster>>["viewer"];
  let roster: Awaited<ReturnType<typeof getAcquisitionRoster>>["roster"];
  try {
    ({ viewer, roster } = await getAcquisitionRoster());
  } catch (error) {
    return loadFailureState(error);
  }

  // A known Acquisitions member keeps the /my-leads route when rollout is
  // off, but never gets a queue read in that state. A roster that no longer
  // represents that member is a recoverable read failure, not an access
  // grant; the client-side queue authorization remains unchanged.
  if (!roster.settings.enabled && isRestrictedAcquisitionMember) {
    return disabledState();
  }

  if (!canViewMyLeads(roster, viewer.userId, viewer.isOwner)) {
    if (isRestrictedAcquisitionMember) return unavailableState();
    notFound();
  }

  let data:
    | {
        viewer: typeof viewer;
        roster: typeof roster;
        memberId: string;
        snapshot: Awaited<ReturnType<typeof getAcquisitionQueue>> | null;
        kpis: Awaited<ReturnType<typeof getAcquisitionKpis>> | null;
      }
    | null = null;
  try {
    const memberId = viewer.isOwner
      ? roster.members.find((member) => member.active && member.acquisitionsEnabled)
          ?.id ?? viewer.userId
      : viewer.userId;
    const [snapshot, kpis] = roster.settings.enabled
      ? await Promise.all([
          getAcquisitionQueue({ memberId }),
          getAcquisitionKpis({ memberId, period: "today" }),
        ])
      : [null, null];
    data = { viewer, roster, memberId, snapshot, kpis };
  } catch (error) {
    return loadFailureState(error);
  }

  return (
    <Page>
      <MyLeadsClient
        viewer={data.viewer}
        roster={data.roster}
        initialMemberId={data.memberId}
        initialSnapshot={data.snapshot}
        initialKpis={data.kpis}
      />
    </Page>
  );
}
