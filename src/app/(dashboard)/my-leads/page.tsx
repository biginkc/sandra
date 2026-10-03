import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import {
  getCallerMembershipsOrThrow,
  type Membership,
} from "@/lib/auth/memberships";
import { shouldRestrictMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import { reportError } from "@/lib/errors/report";
import { createSupabaseDialpadDispatchDb, loadDialpadPanelBootstrap } from "@/lib/dialpad-cti/dispatch";
import { canViewMyLeads } from "@/lib/my-leads/access";
import { listMyLeadsInDrip } from "@/lib/my-leads/drip-queries";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getAcquisitionKpis,
  getAcquisitionQueue,
  getAcquisitionRoster,
  getMyLeadsQueueRow,
  MyLeadsReadError,
} from "@/lib/my-leads/queries";

import { MyLeadsClient } from "./client";
import {
  parseSelectedLeadParam,
  selectedLeadUnavailableMessage,
  type MyLeadsSearchParams,
  type SelectedLeadResult,
} from "./deep-link";

function unavailableState(retryHref = "/my-leads") {
  return (
    <Page>
      <PageHeader title="My Leads" />
      <div role="alert" className="text-destructive text-sm">
        <span>My Leads is temporarily unavailable. </span>
        {/* Reload the document so Retry reruns the failed server reads even on this same URL. */}
        <a href={retryHref} className="font-bold underline underline-offset-4">
          Retry
        </a>
      </div>
    </Page>
  );
}

function selectedLeadUnavailableState(retryHref: string) {
  return (
    <Page>
      <PageHeader title="My Leads" />
      <div role="alert" className="text-destructive text-sm">
        <span>This lead is unavailable in your My Leads queue. </span>
        <a href={retryHref} className="font-bold underline underline-offset-4">
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

function loadFailureState(error: unknown, retryHref = "/my-leads") {
  // Only expose the stable rollout state. All transport, database, and
  // authorization failures use the same retryable message so internal
  // details cannot reach the page.
  return isFeatureDisabled(error) ? disabledState() : unavailableState(retryHref);
}

function selectedLeadRetryHref(selectedLeadLink: ReturnType<typeof parseSelectedLeadParam>): string {
  return selectedLeadLink.status === "requested"
    ? `/my-leads?lead=${encodeURIComponent(selectedLeadLink.propertyId)}`
    : "/my-leads";
}

export default async function MyLeadsPage({
  searchParams,
}: {
  searchParams?: Promise<MyLeadsSearchParams>;
}) {
  const selectedLeadLink = parseSelectedLeadParam(
    searchParams ? await searchParams : undefined,
  );
  const retryHref = selectedLeadRetryHref(selectedLeadLink);
  let memberships: Membership[];
  try {
    memberships = await getCallerMembershipsOrThrow();
  } catch (error) {
    return loadFailureState(error, retryHref);
  }

  // `getAcquisitionRoster` also requires one active organization. Resolve
  // that boundary before the roster call so a missing or ambiguous scope is
  // an explicit unavailable state rather than an accidental 404 or 500.
  if (memberships.length !== 1) return unavailableState(retryHref);

  const isRestrictedAcquisitionMember =
    shouldRestrictMessagesAndLeadsBoard(memberships);

  let viewer: Awaited<ReturnType<typeof getAcquisitionRoster>>["viewer"];
  let roster: Awaited<ReturnType<typeof getAcquisitionRoster>>["roster"];
  try {
    ({ viewer, roster } = await getAcquisitionRoster());
  } catch (error) {
    return loadFailureState(error, retryHref);
  }

  // A known Acquisitions member keeps the /my-leads route when rollout is
  // off, but never gets a queue read in that state. A roster that no longer
  // represents that member is a recoverable read failure, not an access
  // grant; the client-side queue authorization remains unchanged.
  if (!roster.settings.enabled && isRestrictedAcquisitionMember) {
    return disabledState();
  }

  if (!canViewMyLeads(roster, viewer.userId, viewer.isOwner)) {
    if (selectedLeadLink.status === "requested" && !viewer.isOwner) {
      return selectedLeadUnavailableState(retryHref);
    }
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
        drips: Awaited<ReturnType<typeof listMyLeadsInDrip>> | null;
      }
    | null = null;
  try {
    // Owners can switch reps, but every viewer starts on their own profile.
    const memberId = viewer.userId;
    const [snapshot, kpis, drips] = roster.settings.enabled
      ? await Promise.all([
          getAcquisitionQueue({ memberId }),
          getAcquisitionKpis({ memberId, period: "today" }),
          listMyLeadsInDrip(memberId),
        ])
      : [null, null, null];
    data = { viewer, roster, memberId, snapshot, kpis, drips };
  } catch (error) {
    return loadFailureState(error, retryHref);
  }

  let selectedLead: SelectedLeadResult = selectedLeadLink.status === "none"
    ? { status: "none" }
    : selectedLeadLink.status === "invalid"
      ? selectedLeadLink
      : { status: "unavailable", message: "This lead is unavailable in your My Leads queue." };

  if (selectedLeadLink.status === "requested" && data.roster.settings.enabled) {
    try {
      // Resolve every deep link against the signed-in user's own queue. Owners
      // may browse other queues interactively, but a URL never changes their
      // selected owner or grants access to another representative's lead.
      const lookup = await getMyLeadsQueueRow({
        memberId: data.viewer.userId,
        propertyId: selectedLeadLink.propertyId,
      });
      selectedLead = lookup.status === "found"
        ? typeof lookup.row.propertyId === "string" && lookup.row.propertyId.toLowerCase() === selectedLeadLink.propertyId
          ? { status: "found", propertyId: selectedLeadLink.propertyId, row: lookup.row, snapshotAt: lookup.snapshotAt }
          : { status: "unavailable", message: "This lead is unavailable in your My Leads queue." }
        : ["archived", "no_active_episode"].includes(lookup.reason)
          ? { status: "terminal", message: selectedLeadUnavailableMessage(lookup.reason) }
          : { status: "unavailable", message: selectedLeadUnavailableMessage(lookup.reason) };
    } catch (error) {
      if (error instanceof MyLeadsReadError && ["FORBIDDEN", "INVALID_INPUT", "NOT_FOUND", "UNAUTHENTICATED"].includes(error.code)) {
        selectedLead = { status: "unavailable", message: "This lead is unavailable in your My Leads queue." };
      } else {
        selectedLead = {
          status: "error",
          message: "We couldn't check this lead right now.",
          retryHref,
        };
      }
    }
  } else if (selectedLeadLink.status === "requested") {
    selectedLead = {
      status: "unavailable",
      message: "My Leads is disabled for this organization.",
      retryHref,
    };
  }

  // Only a usable connection (active, fixed Dialpad origin allowed) surfaces the panel; any failure keeps the existing softphone flow.
  let dialpad: Awaited<ReturnType<typeof loadDialpadPanelBootstrap>> = null;
  if (data.roster.settings.enabled) {
    try {
      dialpad = await loadDialpadPanelBootstrap(createSupabaseDialpadDispatchDb(createAdminClient()), {
        orgId: data.viewer.orgId,
        userId: data.viewer.userId,
      });
    } catch (error) {
      reportError(error instanceof Error ? error : new Error("dialpad panel bootstrap failed"), {
        errorClass: "database",
        tags: { surface: "server", operation: "dialpad_panel_bootstrap" },
      });
    }
  }

  return (
    <Page>
      <MyLeadsClient
        dialpad={dialpad}
        viewer={data.viewer}
        roster={data.roster}
        initialMemberId={data.memberId}
        initialSnapshot={data.snapshot}
        initialKpis={data.kpis}
        initialDrips={data.drips}
        selectedLead={selectedLead}
      />
    </Page>
  );
}
