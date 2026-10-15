import type { LooseSupabase } from "./queries";
import type { OpenHold, RunWithSteps } from "./types";

const CHUNK = 100;

/**
 * Drops holds whose property is permanently do-not-contact locked
 * (`properties.is_dnc_locked`): nobody can act on them, so they must not sit in
 * "Waiting for a person". If the lookup fails the holds are kept (a visible
 * extra card is safer than a silently hidden one).
 */
export async function withoutDncLocked(
  supabase: LooseSupabase,
  orgId: string,
  holds: OpenHold<RunWithSteps>[],
): Promise<OpenHold<RunWithSteps>[]> {
  const ids = [...new Set(holds.flatMap((h) => (h.property_id ? [h.property_id] : [])))];
  if (ids.length === 0) return holds;
  const locked = new Set<string>();
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("properties")
        .select("id")
        .eq("org_id", orgId)
        .eq("is_dnc_locked", true)
        .in("id", ids.slice(i, i + CHUNK));
      if (error) return holds;
      for (const row of (data ?? []) as Array<{ id: string }>) locked.add(row.id);
    }
  } catch {
    return holds;
  }
  return holds.filter((h) => !h.property_id || !locked.has(h.property_id));
}
