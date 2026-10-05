import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

type EnqueueClient = {
  rpc(
    fn: "fn_enqueue_comp_fetch",
    args: { p_org_id: string; p_property_id: string; p_trigger: string; p_requested_by: string | null },
  ): PromiseLike<{ data: unknown; error: unknown }>;
};

/**
 * Enqueues comps for the strip's current top ten. Ignores every non-`queued` outcome (fresh,
 * in-flight, disabled, capped, unavailable) and never throws: this runs in Next `after()` and
 * must not affect the strip render. The caller checks the `comp_queue` flag first.
 */
export async function enqueueTopTenComps(
  orgId: string,
  propertyIds: readonly string[],
  trigger: "top_ten" = "top_ten",
  client?: EnqueueClient,
): Promise<void> {
  if (!orgId || propertyIds.length === 0) return;
  let admin: EnqueueClient;
  try {
    admin = client ?? (createAdminClient() as unknown as EnqueueClient);
  } catch {
    return;
  }
  for (const propertyId of propertyIds.slice(0, 10)) {
    try {
      await admin.rpc("fn_enqueue_comp_fetch", {
        p_org_id: orgId,
        p_property_id: propertyId,
        p_trigger: trigger,
        p_requested_by: null,
      });
    } catch {
      // Swallowed on purpose: a missing function (migration not landed) or a transient error must
      // never surface from the strip loader.
    }
  }
}

/**
 * Strip trigger (§3.4): enqueue the current top ten only when the org's `comp_queue` flag is on
 * and the `lead_comps` schema is ready. Meant for Next `after()` so it never blocks the render.
 */
export async function enqueueStripComps(
  orgId: string,
  propertyIds: readonly string[],
  deps?: { flagEnabled?: (orgId: string) => Promise<boolean>; schemaReady?: () => Promise<boolean>; enqueue?: typeof enqueueTopTenComps },
): Promise<boolean> {
  try {
    const { getMyLeadsFlag } = await import("@/lib/my-leads/flags");
    const { schemaReady } = await import("@/lib/my-leads/schema-ready");
    const flagEnabled = deps?.flagEnabled ?? ((id: string) => getMyLeadsFlag(id, "comp_queue"));
    const ready = deps?.schemaReady ?? (() => schemaReady("lead_comps"));
    if (!(await flagEnabled(orgId)) || !(await ready())) return false;
    await (deps?.enqueue ?? enqueueTopTenComps)(orgId, propertyIds, "top_ten");
    return true;
  } catch {
    return false;
  }
}
