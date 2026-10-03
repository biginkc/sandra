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
import { createClient } from "@/lib/supabase/server";
import {
  getAcquisitionKpis,
  getAcquisitionQueue,
  getAcquisitionRoster,
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
 * Resolves a `?lead=` deep link to the rep queue that holds it, pre-filtering
 * by address so the lead is on the first page. Reads go through the viewer's
 * RLS-scoped client, so a lead outside the viewer's org resolves to nothing.
 */
async function resolveFocus(
  viewer: { userId: string; isOwner: boolean },
  memberIds: ReadonlySet<string>,
  params: SearchParams,
): Promise<{ focus: MyLeadsFocus; memberId: string; search: string } | null> {
  const propertyId = firstParam(params.lead);
  if (!propertyId || !UUID.test(propertyId)) return null;
  const action = firstParam(params.action) === "log-attempt" ? "log-attempt" : null;
  const notInQueue = (notice: string) => ({
    focus: { propertyId: null, action: null, notice },
    memberId: viewer.userId,
    search: "",
  });
  const client = await createClient();
  const { data, error } = await client
    .from("properties")
    .select("id,address,assigned_user_id")
    .eq("id", propertyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return notInQueue("That lead could not be found.");
  const assignee = data.assigned_user_id as string | null;
  if (!assignee) return notInQueue("That lead is not assigned to a rep yet, so it is not in My Leads. Assign it from the lead page first.");
  if (assignee !== viewer.userId && (!viewer.isOwner || !memberIds.has(assignee))) return notInQueue("That lead is assigned to another rep, so it is not in your My Leads queue.");
  return {
    focus: { propertyId, action, notice: null },
    memberId: assignee,
    search: ((data.address as string | null) ?? "").trim().slice(0, 200),
  };
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
        search: string;
      }
    | null = null;
  let focus: MyLeadsFocus | null = null;
  try {
    // Owners can switch reps, but every viewer starts on their own profile
    // unless a deep link names a lead in another rep's queue.
    const resolved = await resolveFocus(viewer, new Set(roster.members.map((m) => m.id)), await searchParams);
    const memberId = resolved?.memberId ?? viewer.userId;
    const search = resolved?.search ?? "";
    focus = resolved?.focus ?? null;
    const [snapshot, kpis, drips] = roster.settings.enabled
      ? await Promise.all([
          getAcquisitionQueue(search ? { memberId, search } : { memberId }),
          getAcquisitionKpis({ memberId, period: "today" }),
          listMyLeadsInDrip(memberId),
        ])
      : [null, null, null];
    data = { viewer, roster, memberId, snapshot, kpis, drips, search };
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
        initialSearch={data.search}
        focus={focus}
      />
    </Page>
  );
}
