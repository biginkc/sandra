"use server";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { err, type Result } from "@/lib/errors/result";
import { createClient } from "@/lib/supabase/server";

import { messagesV2OrgId } from "./access";
import { withoutDncLocked } from "./dnc-locked";
import { withFreshSeen } from "./hold-seen";
import { loadRunLabels } from "./labels";
import { BACKLOG_PAGE, loadBacklogHolds, type LooseSupabase } from "./queries";
import { parseSnapshotIds } from "./hold-activity";
import { liveStateOf, type HoldLiveState } from "./hold-list";
import { loadHoldsByIds } from "./holds-by-activity";
import type { BacklogPage, OlderHoldsPage } from "./hold-action-types";

const MAX_PAGE = 500;

const clampInt = (v: unknown, fallback: number, max: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), max) : fallback;
};

/**
 * Loads one page of Backlog holds for the rail's collapsed section. The caller
 * and org are resolved on the server (owner || acquisitions, same gate as the
 * page); only the paging window comes from the client.
 */
export async function loadBacklogHoldsAction(input: {
  offset: number;
  limit?: number;
}): Promise<Result<BacklogPage>> {
  let orgId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id) {
      // Only this user's own memberships count (same rule as the hold actions).
      const memberships = (await getCallerMembershipsOrThrow()).filter(
        (m) => m.user_id === user.id,
      );
      orgId = messagesV2OrgId(memberships);
    }
  } catch {
    orgId = null;
  }
  if (!orgId) {
    return err({ code: "UNAUTHORIZED", message: "You do not have access to Messages v2." });
  }
  const offset = clampInt(input?.offset, 0, 1_000_000);
  const limit = Math.max(1, clampInt(input?.limit, BACKLOG_PAGE, MAX_PAGE));
  const supabase = (await createClient()) as unknown as LooseSupabase;
  const page = await loadBacklogHolds(supabase, orgId, offset, limit, undefined, {
    includeLuna: false, // Luna suggestions are no longer rendered on the page
    bucket: "backlog",
  });
  if (!page || page.failed) {
    return err({ code: "BACKLOG_UNAVAILABLE", message: "Backlog holds could not be loaded." });
  }
  const holds = await withoutDncLocked(supabase, orgId, await withFreshSeen(supabase, orgId, page.holds));
  if (!holds) {
    return err({ code: "BACKLOG_UNAVAILABLE", message: "Backlog holds could not be verified." });
  }
  const labels = await loadRunLabels(
    supabase,
    holds.map((h) => ({
      id: h.id,
      contact_id: h.run?.contact_id ?? null,
      property_id: h.property_id,
      inbound_message_id: h.run?.inbound_message_id ?? "",
    })),
  );
  return {
    ok: true,
    data: {
      holds,
      labels: [...labels.entries()],
      backlogTotal: page.backlogTotal,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
    },
  };
}

/**
 * "Show older" for the waiting column: the next slice of ONE ordering (latest
 * activity first, DNC-locked excluded) across every open hold, New and Backlog.
 */
export async function loadOlderHoldsAction(input: { ids: string[] }): Promise<Result<OlderHoldsPage>> {
  let orgId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id) {
      const memberships = (await getCallerMembershipsOrThrow()).filter((m) => m.user_id === user.id);
      orgId = messagesV2OrgId(memberships);
    }
  } catch {
    orgId = null;
  }
  if (!orgId) {
    return err({ code: "UNAUTHORIZED", message: "You do not have access to Messages v2." });
  }
  // At most 100 uuids. Org scope, DNC lock and open status are re-checked by building the CURRENT list for this
  // caller's org: an id from another org, a locked or a resolved hold simply comes back in `missing`.
  const ids = parseSnapshotIds(input?.ids);
  if (!ids) return err({ code: "VALIDATION", message: "Bad ids." });
  const supabase = (await createClient()) as unknown as LooseSupabase;
  const slice = await loadHoldsByIds(supabase, orgId, ids);
  if (!slice) {
    return err({ code: "OLDER_UNAVAILABLE", message: "Older waiting texts could not be loaded." });
  }
  const holds = slice.holds;
  const labels = await loadRunLabels(
    supabase,
    holds.map((h) => ({
      id: h.id,
      contact_id: h.run?.contact_id ?? null,
      property_id: h.property_id,
      inbound_message_id: h.run?.inbound_message_id ?? "",
    })),
  );
  return {
    ok: true,
    data: {
      holds,
      labels: [...labels.entries()],
      missing: slice.missing,
      unverified: slice.unverified,
      contextErrors: slice.contextErrors,
    },
  };
}

/**
 * Re-check rendered waiting cards while the page stays open (properties is not in the realtime publication and
 * PR 1 adds no migration). Same auth path; at most 100 uuids; org-scoped by building this caller's current list.
 */
export async function revalidateHoldsAction(input: { ids: string[] }): Promise<Result<HoldLiveState[]>> {
  let orgId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user?.id) {
      const memberships = (await getCallerMembershipsOrThrow()).filter((m) => m.user_id === user.id);
      orgId = messagesV2OrgId(memberships);
    }
  } catch {
    orgId = null;
  }
  if (!orgId) return err({ code: "UNAUTHORIZED", message: "You do not have access to Messages v2." });
  const ids = parseSnapshotIds(input?.ids);
  if (!ids) return err({ code: "VALIDATION", message: "Bad ids." });
  const supabase = (await createClient()) as unknown as LooseSupabase;
  const states = await liveStateOf(supabase, orgId, ids);
  if (!states) return err({ code: "REVALIDATE_UNAVAILABLE", message: "Waiting list could not be checked." });
  return { ok: true, data: states };
}
