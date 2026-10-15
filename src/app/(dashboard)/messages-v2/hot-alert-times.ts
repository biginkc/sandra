import { hotPromotionKey } from "@/lib/hot-sellers/hot";

import type { LooseSupabase } from "./queries";
import type { RunWithSteps } from "./types";

/**
 * When Jarrad's hot-seller alerts went out, per property: the later of the
 * Slack and text `sent_at`, and only once BOTH are sent (hold_alert_deliveries,
 * key `hot_promotion:<property>`). Display only; a failed lookup shows no time.
 */
export async function loadHotAlertTimes(
  supabase: LooseSupabase,
  orgId: string,
  propertyIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(propertyIds)];
  if (ids.length === 0) return out;
  const keys = ids.map(hotPromotionKey);
  const res = await supabase
    .from("hold_alert_deliveries")
    .select("hold_key, channel, sent_at")
    .eq("org_id", orgId)
    .eq("status", "sent")
    .in("hold_key", keys);
  if (res.error) return out;
  const byKey = new Map<string, { slack?: string; sms?: string }>();
  for (const row of (res.data ?? []) as Array<{ hold_key: string; channel: string; sent_at: string | null }>) {
    if (!row.sent_at || (row.channel !== "slack" && row.channel !== "sms")) continue;
    const entry = byKey.get(row.hold_key) ?? {};
    entry[row.channel] = row.sent_at;
    byKey.set(row.hold_key, entry);
  }
  for (const id of ids) {
    const e = byKey.get(hotPromotionKey(id));
    if (e?.slack && e.sms) out.set(id, Date.parse(e.slack) >= Date.parse(e.sms) ? e.slack : e.sms);
  }
  return out;
}

/** Runs that handed a hot seller to Jarrad get `hotAlertSentAt` when both alerts are out. */
export async function attachHotAlertTimes(
  supabase: LooseSupabase,
  orgId: string,
  runs: RunWithSteps[],
): Promise<RunWithSteps[]> {
  const handed = runs.filter((r) => r.property_id && r.steps.some((s) => s.name === "assign_hot_lead" && s.result === "applied"));
  if (handed.length === 0) return runs;
  const times = await loadHotAlertTimes(supabase, orgId, handed.map((r) => r.property_id as string));
  return runs.map((r) => (r.property_id && times.has(r.property_id) ? { ...r, hotAlertSentAt: times.get(r.property_id) ?? null } : r));
}
