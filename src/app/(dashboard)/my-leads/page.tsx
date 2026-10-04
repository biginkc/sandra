import { notFound } from "next/navigation";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import {
  getCallerMembershipsOrThrow,
  type Membership,
} from "@/lib/auth/memberships";
import { shouldRestrictMessagesAndLeadsBoard } from "@/lib/auth/surface-access";
import { reportError } from "@/lib/errors/report";
import {
  createSupabaseDialpadDispatchDb,
  loadDialpadPanelBootstrap,
} from "@/lib/dialpad-cti/dispatch";
import { canViewMyLeads } from "@/lib/my-leads/access";
import {
  MY_LEAD_ROW_ERROR_COPY,
  MY_LEAD_ROW_FORBIDDEN_COPY,
  MY_LEAD_ROW_REASON_COPY,
} from "@/lib/my-leads/row-reasons";
import { listMyLeadsInDrip } from "@/lib/my-leads/drip-queries";
import { getCallNext } from "@/lib/my-leads/call-next";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getAcquisitionKpis,
  getAcquisitionQueue,
  getAcquisitionRoster,
  getMyLeadsQueueRow,
  MyLeadsReadError,
} from "@/lib/my-leads/queries";

import { MyLeadsClient, type MyLeadsFocus } from "./client";
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
  if (error instanceof MyLeadsReadError)
    return error.code === "FEATURE_DISABLED";
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "FEATURE_DISABLED"
  );
}

function loadFailureState(error: unknown, retryHref = "/my-leads") {
  return isFeatureDisabled(error)
    ? disabledState()
    : unavailableState(retryHref);
}

function selectedLeadRetryHref(
  selectedLeadLink: ReturnType<typeof parseSelectedLeadParam>,
): string {
  return selectedLeadLink.status === "requested"
    ? `/my-leads?lead=${encodeURIComponent(selectedLeadLink.propertyId)}`
    : "/my-leads";
}

function focusForSelectedLead(
  result: SelectedLeadResult,
  userId: string,
): MyLeadsFocus | null {
  if (result.status === "none" || result.status === "invalid") return null;
  if (result.status === "found") {
    return {
      propertyId: result.propertyId,
      memberId: userId,
      notice: null,
      pin: result.row,
    };
  }
  return {
    propertyId: result.propertyId,
    memberId: userId,
    notice: result.message,
    pin: null,
    pinStatus: result.status === "error" ? "failed" : "unavailable",
    retryHref: result.retryHref,
  };
}

export default async function MyLeadsPage({
  searchParams,
}: {
  searchParams: Promise<MyLeadsSearchParams>;
}) {
  const selectedLeadLink = parseSelectedLeadParam(await searchParams);
  const retryHref = selectedLeadRetryHref(selectedLeadLink);

  let memberships: Membership[];
  try {
    memberships = await getCallerMembershipsOrThrow();
  } catch (error) {
    return loadFailureState(error, retryHref);
  }

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

  // A linked request never changes this boundary. A known member with rollout
  // disabled gets the same neutral disabled state, and no lead lookup runs.
  if (!roster.settings.enabled && isRestrictedAcquisitionMember)
    return disabledState();

  if (!canViewMyLeads(roster, viewer.userId, viewer.isOwner)) {
    if (selectedLeadLink.status === "requested")
      return selectedLeadUnavailableState(retryHref);
    if (isRestrictedAcquisitionMember) return unavailableState();
    notFound();
  }

  let snapshot: Awaited<ReturnType<typeof getAcquisitionQueue>> | null = null;
  let kpis: Awaited<ReturnType<typeof getAcquisitionKpis>> | null = null;
  let drips: Awaited<ReturnType<typeof listMyLeadsInDrip>> | null = null;
  // The Call next strip is additive: null when it is off (flag or schema not ready) and also
  // null when its read fails, so it can never blank or fail the existing page.
  const stripRead: Promise<Awaited<ReturnType<typeof getCallNext>>> =
    roster.settings.enabled
      ? getCallNext({ memberId: viewer.userId }).catch((error) => {
          reportError(
            error instanceof Error ? error : new Error("call next read failed"),
            {
              errorClass: "database",
              tags: { surface: "database", operation: "my_leads_call_next" },
            },
          );
          return null;
        })
      : Promise.resolve(null);
  try {
    if (roster.settings.enabled) {
      [snapshot, kpis, drips] = await Promise.all([
        getAcquisitionQueue({ memberId: viewer.userId }),
        getAcquisitionKpis({ memberId: viewer.userId, period: "today" }),
        listMyLeadsInDrip(viewer.userId),
      ]);
    }
  } catch (error) {
    return loadFailureState(error, retryHref);
  }

  const initialStrip = await stripRead;

  let selectedLead: SelectedLeadResult =
    selectedLeadLink.status === "none"
      ? { status: "none" }
      : selectedLeadLink.status === "invalid"
        ? selectedLeadLink
        : {
            status: "unavailable",
            propertyId: selectedLeadLink.propertyId,
            message: "This lead is unavailable in your My Leads queue.",
            retryHref,
          };
  let focus = focusForSelectedLead(selectedLead, viewer.userId);

  // The URL is only a lookup key. Always read the signed-in user's queue, even
  // for owners; a URL cannot grant access or silently switch their queue.
  if (selectedLeadLink.status === "requested" && roster.settings.enabled) {
    try {
      const lookup = await getMyLeadsQueueRow({
        memberId: viewer.userId,
        propertyId: selectedLeadLink.propertyId,
      });
      if (
        lookup.status === "found" &&
        typeof lookup.row.propertyId === "string" &&
        lookup.row.propertyId.toLowerCase() === selectedLeadLink.propertyId
      ) {
        selectedLead = {
          status: "found",
          propertyId: selectedLeadLink.propertyId,
          row: lookup.row,
          snapshotAt: lookup.snapshotAt,
        };
        focus = {
          propertyId: selectedLeadLink.propertyId,
          memberId: viewer.userId,
          notice: null,
          pin: lookup.row,
        };
      } else if (lookup.status === "unavailable") {
        selectedLead = ["archived", "no_active_episode"].includes(lookup.reason)
          ? {
              status: "terminal",
              propertyId: selectedLeadLink.propertyId,
              message: selectedLeadUnavailableMessage(lookup.reason),
              retryHref,
            }
          : {
              status: "unavailable",
              propertyId: selectedLeadLink.propertyId,
              message: selectedLeadUnavailableMessage(lookup.reason),
              retryHref,
            };
        focus = {
          propertyId: selectedLeadLink.propertyId,
          memberId: viewer.userId,
          notice: MY_LEAD_ROW_REASON_COPY[lookup.reason],
          pin: null,
          pinStatus: "unavailable",
          retryHref,
        };
      }
    } catch (error) {
      if (
        error instanceof MyLeadsReadError &&
        ["FORBIDDEN", "INVALID_INPUT", "NOT_FOUND", "UNAUTHENTICATED"].includes(
          error.code,
        )
      ) {
        selectedLead = {
          status: "unavailable",
          propertyId: selectedLeadLink.propertyId,
          message: "This lead is unavailable in your My Leads queue.",
          retryHref,
        };
        focus = {
          propertyId: selectedLeadLink.propertyId,
          memberId: viewer.userId,
          notice:
            error.code === "FORBIDDEN"
              ? MY_LEAD_ROW_FORBIDDEN_COPY
              : MY_LEAD_ROW_REASON_COPY.not_found,
          pin: null,
          pinStatus: "unavailable",
          retryHref,
        };
      } else {
        selectedLead = {
          status: "error",
          propertyId: selectedLeadLink.propertyId,
          message: "We couldn't check this lead right now.",
          retryHref,
        };
        focus = {
          propertyId: selectedLeadLink.propertyId,
          memberId: viewer.userId,
          notice: MY_LEAD_ROW_ERROR_COPY,
          pin: null,
          pinStatus: "failed",
          retryHref,
        };
      }
    }
  } else if (selectedLeadLink.status === "requested") {
    selectedLead = {
      status: "unavailable",
      propertyId: selectedLeadLink.propertyId,
      message: "My Leads is disabled for this organization.",
      retryHref,
    };
  }

  let dialpad: Awaited<ReturnType<typeof loadDialpadPanelBootstrap>> = null;
  if (roster.settings.enabled) {
    try {
      dialpad = await loadDialpadPanelBootstrap(
        createSupabaseDialpadDispatchDb(createAdminClient()),
        {
          orgId: viewer.orgId,
          userId: viewer.userId,
        },
      );
    } catch (error) {
      reportError(
        error instanceof Error
          ? error
          : new Error("dialpad panel bootstrap failed"),
        {
          errorClass: "database",
          tags: { surface: "database", operation: "dialpad_panel_bootstrap" },
        },
      );
    }
  }

  return (
    <Page>
      <MyLeadsClient
        dialpad={dialpad}
        viewer={viewer}
        roster={roster}
        initialMemberId={viewer.userId}
        initialSnapshot={snapshot}
        initialKpis={kpis}
        initialDrips={drips}
        initialStrip={initialStrip}
        selectedLead={selectedLead}
        focus={focus}
      />
    </Page>
  );
}
