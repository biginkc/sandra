import { fetchAllKeyset } from "./paged";
import type { LooseSupabase } from "./queries";
import type { OpenHold, RunWithSteps } from "./types";

const CHUNK = 100;

/**
 * Which of these properties are permanently do-not-contact locked. Returns null
 * when any lookup fails: callers must fail closed (error state, no cards).
 */
export async function lockedPropertyIds(
  supabase: LooseSupabase,
  orgId: string,
  propertyIds: readonly string[],
): Promise<Set<string> | null> {
  const ids = [...new Set(propertyIds)];
  const locked = new Set<string>();
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const slice = ids.slice(i, i + CHUNK);
      // Keyset-paged: a server row cap must never silently drop a locked id (that would fail open).
      const res = await fetchAllKeyset<{ id: string }>(() =>
        supabase.from("properties").select("id").eq("org_id", orgId).eq("is_dnc_locked", true).in("id", slice),
      );
      if (res.error) return null;
      for (const row of res.rows) locked.add(row.id);
    }
  } catch {
    return null;
  }
  return locked;
}

/**
 * Drops holds whose property is permanently do-not-contact locked
 * (`properties.is_dnc_locked`): nobody can act on them, so they must not sit in
 * "Waiting for a person". FAILS CLOSED: if the lock lookup fails this returns
 * null and the caller must show an error and render no cards, because a hold
 * on an unverified property could be a locked one.
 */
export async function withoutDncLocked(
  supabase: LooseSupabase,
  orgId: string,
  holds: OpenHold<RunWithSteps>[],
): Promise<OpenHold<RunWithSteps>[] | null> {
  const ids = holds.flatMap((h) => (h.property_id ? [h.property_id] : []));
  if (ids.length === 0) return holds;
  const locked = await lockedPropertyIds(supabase, orgId, ids);
  if (!locked) return null;
  return holds.filter((h) => !h.property_id || !locked.has(h.property_id));
}
