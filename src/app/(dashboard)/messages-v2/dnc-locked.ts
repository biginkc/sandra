import type { LooseSupabase } from "./queries";
import type { OpenHold, RunWithSteps } from "./types";

const CHUNK = 100;

/**
 * Which of these properties are permanently do-not-contact locked. Returns null
 * when any lookup fails: callers keep everything (a visible extra card is safer
 * than a silently hidden one).
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
      const { data, error } = await supabase
        .from("properties")
        .select("id")
        .eq("org_id", orgId)
        .eq("is_dnc_locked", true)
        .in("id", ids.slice(i, i + CHUNK));
      if (error) return null;
      for (const row of (data ?? []) as Array<{ id: string }>) locked.add(row.id);
    }
  } catch {
    return null;
  }
  return locked;
}

/**
 * Drops holds whose property is permanently do-not-contact locked
 * (`properties.is_dnc_locked`): nobody can act on them, so they must not sit in
 * "Waiting for a person". If the lookup fails the holds are kept.
 */
export async function withoutDncLocked(
  supabase: LooseSupabase,
  orgId: string,
  holds: OpenHold<RunWithSteps>[],
): Promise<OpenHold<RunWithSteps>[]> {
  const ids = holds.flatMap((h) => (h.property_id ? [h.property_id] : []));
  if (ids.length === 0) return holds;
  const locked = await lockedPropertyIds(supabase, orgId, ids);
  if (!locked) return holds;
  return holds.filter((h) => !h.property_id || !locked.has(h.property_id));
}
