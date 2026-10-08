"use server";

import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { err, type Result } from "@/lib/errors/result";
import { createClient } from "@/lib/supabase/server";

import { messagesV2OrgId } from "./access";
import { withFreshSeen } from "./hold-seen";
import { loadRunLabels } from "./labels";
import { BACKLOG_PAGE, loadBacklogHolds, type LooseSupabase } from "./queries";
import type { BacklogPage } from "./hold-action-types";

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
  const page = await loadBacklogHolds(supabase, orgId, offset, limit);
  if (!page || page.failed) {
    return err({ code: "BACKLOG_UNAVAILABLE", message: "Backlog holds could not be loaded." });
  }
  const holds = await withFreshSeen(supabase, orgId, page.holds);
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
