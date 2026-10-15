import { hotPromotionKey, hotTextKey } from "@/lib/hot-sellers/hot";

import type { LooseSupabase } from "./queries";
import type { RunWithSteps } from "./types";

/**
 * When Jarrad's hot-seller alerts went out, per delivery key: the later of the
 * Slack and text `sent_at`, and only once BOTH are sent (hold_alert_deliveries).
 * Display only; a failed lookup shows no time.
 */
export async function loadHotAlertTimes(
  supabase: LooseSupabase,
  orgId: string,
  holdKeys: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const keys = [...new Set(holdKeys)];
  if (keys.length === 0) return out;
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
  for (const [key, e] of byKey) {
    if (e.slack && e.sms) out.set(key, Date.parse(e.slack) >= Date.parse(e.sms) ? e.slack : e.sms);
  }
  return out;
}

/** The alert key a hot run's hand-off step points at (null when the run has none). */
export function hotAlertKeyForRun(run: RunWithSteps): string | null {
  if (!run.property_id) return null;
  const step = run.steps.find((s) => s.name === "assign_hot_lead" && s.result === "applied");
  if (!step) return null;
  const status = (step.detail as { status?: string } | null)?.status;
  if (status === "already_owned") return run.inbound_message_id ? hotTextKey(run.inbound_message_id) : null;
  return hotPromotionKey(run.property_id);
}

/** Runs that handed a hot seller to Jarrad get `hotAlertSentAt` when both alerts are out. */
export async function attachHotAlertTimes(
  supabase: LooseSupabase,
  orgId: string,
  runs: RunWithSteps[],
): Promise<RunWithSteps[]> {
  const keyed = runs.map((r) => [r, hotAlertKeyForRun(r)] as const);
  const keys = keyed.flatMap(([, k]) => (k ? [k] : []));
  if (keys.length === 0) return runs;
  const times = await loadHotAlertTimes(supabase, orgId, keys);
  return keyed.map(([r, k]) => (k && times.has(k) ? { ...r, hotAlertSentAt: times.get(k) ?? null } : r));
}
