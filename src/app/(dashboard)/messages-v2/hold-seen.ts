import { compareInstants, type LooseSupabase } from "./queries";
import type { HoldSeen } from "./types";

/**
 * The version a hold card sends back with Dismiss / Take over, read fresh per
 * property. The page's hold queries are windowed (oldest 200 per source), so a
 * property with pending rows beyond that window would show a `through` older
 * than its newest pending row and could never be dismissed (the server would
 * answer STALE forever). This reads each displayed property directly, with no
 * window: the newest pending decision / review / draft created_at, and the
 * flag as it is now.
 */

const CHUNK = 25;
const ROW_LIMIT = 1000;
const PENDING_TABLES = ["jev_lead_decisions", "ai_disposition_reviews", "ai_reply_drafts"] as const;

type TimeRow = { property_id: string | null; created_at: string };
type FlagRow = {
  id: string;
  needs_human_attention: boolean | null;
  last_ai_escalation_reason: string | null;
  last_ai_escalation_at: string | null;
};

const later = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : compareInstants(b, a) > 0 ? b : a;

/**
 * Fresh `seen` per property id. Null when any query fails (the caller keeps the
 * window-derived value rather than guessing).
 */
export async function loadFreshSeen(
  supabase: LooseSupabase,
  orgId: string,
  propertyIds: readonly string[],
): Promise<Map<string, HoldSeen> | null> {
  const out = new Map<string, HoldSeen>();
  const ids = [...new Set(propertyIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const through = new Map<string, string>();

    const flagRes = await supabase
      .from("properties")
      .select("id, needs_human_attention, last_ai_escalation_reason, last_ai_escalation_at")
      .eq("org_id", orgId)
      .in("id", chunk);
    if (flagRes.error) return null;
    const flags = new Map(((flagRes.data ?? []) as FlagRow[]).map((r) => [r.id, r]));

    for (const table of PENDING_TABLES) {
      const res = await supabase
        .from(table)
        .select("property_id, created_at")
        .eq("org_id", orgId)
        .eq("status", "pending")
        .in("property_id", chunk)
        .order("created_at", { ascending: false })
        .limit(ROW_LIMIT);
      if (res.error) return null;
      const rows = (res.data ?? []) as TimeRow[];
      const absorb = (r: TimeRow) => {
        if (r.property_id) through.set(r.property_id, later(through.get(r.property_id) ?? null, r.created_at)!);
      };
      rows.forEach(absorb);
      // Newest-first and truncated: a property missing from the result may still
      // have rows, so ask for its newest one directly.
      if (rows.length >= ROW_LIMIT) {
        const present = new Set(rows.map((r) => r.property_id));
        for (const id of chunk.filter((c) => !present.has(c))) {
          const one = await supabase
            .from(table)
            .select("property_id, created_at")
            .eq("org_id", orgId)
            .eq("status", "pending")
            .in("property_id", [id])
            .order("created_at", { ascending: false })
            .limit(1);
          if (one.error) return null;
          ((one.data ?? []) as TimeRow[]).forEach(absorb);
        }
      }
    }

    for (const id of chunk) {
      const flag = flags.get(id);
      const flagged = flag?.needs_human_attention === true;
      out.set(id, {
        through: through.get(id) ?? null,
        flagReason: flagged ? (flag?.last_ai_escalation_reason ?? null) : null,
        flagAt: flagged ? (flag?.last_ai_escalation_at ?? null) : null,
      });
    }
  }
  return out;
}

/** Window-derived seen merged with the fresh one: never older, and the flag is the live one. */
export function mergeSeen(windowSeen: HoldSeen | undefined, fresh: HoldSeen): HoldSeen {
  return {
    through: later(windowSeen?.through ?? null, fresh.through),
    flagReason: fresh.flagReason,
    flagAt: fresh.flagAt,
  };
}

/**
 * Replaces each displayed hold's `seen` with the fresh, window-free version.
 * On any failure the holds come back unchanged (window-derived seen).
 */
export async function withFreshSeen<H extends { property_id: string | null; seen?: HoldSeen }>(
  supabase: LooseSupabase,
  orgId: string,
  holds: readonly H[],
): Promise<H[]> {
  const ids = holds.flatMap((h) => (h.property_id ? [h.property_id] : []));
  if (ids.length === 0) return [...holds];
  let fresh: Map<string, HoldSeen> | null = null;
  try {
    fresh = await loadFreshSeen(supabase, orgId, ids);
  } catch {
    fresh = null;
  }
  if (!fresh) return [...holds];
  return holds.map((h) => {
    const f = h.property_id ? fresh!.get(h.property_id) : undefined;
    return f ? { ...h, seen: mergeSeen(h.seen, f) } : h;
  });
}
