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
import { MY_LEAD_ROW_ERROR_COPY, MY_LEAD_ROW_FORBIDDEN_COPY, MY_LEAD_ROW_REASON_COPY } from "@/lib/my-leads/row-reasons";
import { listMyLeadsInDrip } from "@/lib/my-leads/drip-queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  getAcquisitionKpis,
  getAcquisitionQueue,
  getAcquisitionRoster,
  getMyLeadsQueueRow,
  MyLeadsReadError,
} from "@/lib/my-leads/queries";

import { MyLeadsClient, type MyLeadsFocus } from "./client";

function unavailableState() {
  return (
    <Page>
      <PageHeader title="My Leads" />
      <div role="alert" className="text-destructive text-sm">
        <span>My Leads is temporarily unavailable. </span>
        {/* Reload the document so Retry reruns the failed server reads even on this same URL. */}
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

type SearchParams = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function firstParam(value: string | string[] | undefined): string | null {
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * Resolves a `?lead=` deep link. The queue itself stays unfiltered; the lead's
 * current row (or the reason it is not in the viewer's queue) comes from the
 * RLS-scoped single-row lookup, never from a search prefill. Only an owner needs
 * the assignee to pick which rep's queue to open.
 */
async function resolveFocus(
  viewer: { userId: string; isOwner: boolean },
  memberIds: ReadonlySet<string>,
  params: SearchParams,
): Promise<{ focus: MyLeadsFocus; memberId: string } | null> {
  const propertyId = firstParam(params.lead);
  if (!propertyId || !UUID.test(propertyId)) return null;
  const notInQueue = (notice: string) => ({
    focus: { propertyId: null, memberId: viewer.userId, notice, pin: null },
    memberId: viewer.userId,
  });
  let memberId = viewer.userId;
  if (viewer.isOwner) {
    try {
      const client = await createClient();
      const { data } = await client
        .from("properties")
        .select("assigned_user_id")
        .eq("id", propertyId)
        .is("deleted_at", null)
        .maybeSingle();
      const assignee = (data?.assigned_user_id as string | null | undefined) ?? null;
      if (assignee && memberIds.has(assignee)) memberId = assignee;
    } catch {
      // Fall back to the owner's own queue; the lookup below still explains the result.
    }
  }
  try {
    const lookup = await getMyLeadsQueueRow({ memberId, propertyId });
    if (lookup.status === "unavailable") return notInQueue(MY_LEAD_ROW_REASON_COPY[lookup.reason]);
    return { focus: { propertyId, memberId, notice: null, pin: lookup.row }, memberId };
  } catch (error) {
    if (error instanceof MyLeadsReadError) {
      if (error.code === "NOT_FOUND") return notInQueue(MY_LEAD_ROW_REASON_COPY.not_found);
      if (error.code === "FORBIDDEN") return notInQueue(MY_LEAD_ROW_FORBIDDEN_COPY);
    }
    return notInQueue(MY_LEAD_ROW_ERROR_COPY);
  }
}

export default async function MyLeadsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
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
        drips: Awaited<ReturnType<typeof listMyLeadsInDrip>> | null;
      }
    | null = null;
  let focus: MyLeadsFocus | null = null;
  try {
    // Owners can switch reps, but every viewer starts on their own profile
    // unless a deep link names a lead in another rep's queue.
    const resolved = roster.settings.enabled
      ? await resolveFocus(viewer, new Set(roster.members.map((m) => m.id)), await searchParams)
      : null;
    const memberId = resolved?.memberId ?? viewer.userId;
    focus = resolved?.focus ?? null;
    const [snapshot, kpis, drips] = roster.settings.enabled
      ? await Promise.all([
          getAcquisitionQueue({ memberId }),
          getAcquisitionKpis({ memberId, period: "today" }),
          listMyLeadsInDrip(memberId),
        ])
      : [null, null, null];
    data = { viewer, roster, memberId, snapshot, kpis, drips };
  } catch (error) {
    return loadFailureState(error);
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
        focus={focus}
      />
    </Page>
  );
}
