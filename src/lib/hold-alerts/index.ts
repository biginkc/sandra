import type { SupabaseClient } from "@supabase/supabase-js";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { loadHeldPropertyIds, loadMessagesV2Data } from "./alert-loader";
import { loadRunLabels } from "@/app/(dashboard)/messages-v2/labels";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { isAcquisitionsCaller } from "@/lib/auth/surface-access";
import type { Database } from "@/lib/supabase/types";

import { createChannelSenders } from "./channels";
import { runHoldAlertsForOrg } from "./core";
import { toAlertHolds } from "./holds";
import { createSupabaseDeliveryStore } from "./store";
import type {
  HoldAlertDeps,
  HoldInfo,
  HotPromotion,
  OrgAlertSummary,
  Recipient,
} from "./types";
import { HOT_FAILED_SOURCE_TYPE, HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE, resolveHotOwner } from "@/lib/hot-sellers/assign";
import { hotFailedKey, hotFlagKey, hotHandoffKey, hotTextKey } from "@/lib/hot-sellers/hot";
import { MAX_ATTEMPTS } from "./types";
import { loadLeadReplies } from "./lead-replies";

export { runHoldAlertsForOrg } from "./core";

type MembershipRow = {
  user_id: string;
  role: "owner" | "member";
  acquisitions_enabled: boolean | null;
  access_status: string | null;
  access_expires_at: string | null;
  deletion_prepared_at: string | null;
};
const MEMBERSHIP_COLUMNS =
  "user_id, role, acquisitions_enabled, access_status, access_expires_at, deletion_prepared_at";

/** Owner or Acquisitions caller, with active Sandra access. Same predicate at load and at send. */
export function isHoldAlertRecipient(m: MembershipRow): boolean {
  return (
    hasActiveSandraAccess(m) && (m.role === "owner" || isAcquisitionsCaller(m))
  );
}

export function resolveAppBaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw =
    env.NEXT_PUBLIC_APP_URL ??
    env.VERCEL_PROJECT_PRODUCTION_URL ??
    "https://sandra-sooty.vercel.app";
  return (raw.startsWith("http") ? raw : `https://${raw}`).replace(/\/+$/, "");
}

/**
 * Open holds from the FROZEN pre-#874 loader (alert-loader.ts, pinned by hash to
 * queries.ts at 84ddabdd6), deliberately isolated from the page's own queries so
 * a page change can never change alert decisions. The run window it selects
 * includes inbound_preview; it is dropped here (hold -> HoldInfo keeps ids and
 * first name only) and never reaches an alert payload.
 */
async function loadAlertHolds(
  db: LooseSupabase,
  orgId: string,
  alertsSince: string,
  nowMs: number,
): Promise<{ holds: HoldInfo[]; complete: boolean }> {
  const data = await loadMessagesV2Data(db, orgId, nowMs, { alertsSince });
  const labels = await loadRunLabels(
    db,
    data.holds.map((h) => ({
      id: h.id,
      contact_id: h.run?.contact_id ?? null,
      property_id: h.property_id,
      inbound_message_id: h.run?.inbound_message_id ?? "",
    })),
  );
  let complete = data.holdsMeta.failed.length === 0;
  const holds = toAlertHolds(data.holds, labels);
  // The hot hold's own moment (flag time) for its alert key and cutoff, read
  // here so the frozen loader stays untouched.
  const hotIds = [...new Set(holds.filter((h) => h.hot).map((h) => h.propertyId))];
  const flagAt = new Map<string, string | null>();
  for (let i = 0; i < hotIds.length; i += 200) {
    const res = await db
      .from("properties")
      .select("id, last_ai_escalation_at")
      .eq("org_id", orgId)
      .in("id", hotIds.slice(i, i + 200));
    if (res.error) {
      complete = false;
      continue;
    }
    for (const p of (res.data ?? []) as Array<{ id: string; last_ai_escalation_at: string | null }>) flagAt.set(p.id, p.last_ai_escalation_at);
  }
  return { holds: holds.map((h) => (h.hot ? { ...h, flagAt: flagAt.get(h.propertyId) ?? null } : h)), complete };
}

const HOT_PROMOTION_PAGE = 200;

/** Same 7-day window as the frozen hold loader (and never before HOT_ALERTS_START_ISO via the watermark). */
export const HOT_ALERT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Hot sellers to alert: Sandra's hand-off ('assigned', source hot_seller_handoff)
 * and hot texts on a lead Jarrad already owned ('ai_escalated', source
 * hot_seller_text), since max(watermark, now - 7 days), NEWEST first, keyset-paged
 * to exhaustion, minus keys whose deliveries are already finished (one bulk
 * query). So history never grows a pass and the newest seller is never starved.
 * First name from the homeowner contact (+ address for hot texts); never message text.
 */
export async function loadHotPromotions(
  db: LooseSupabase,
  orgId: string,
  alertsSince: string,
  nowMs: number = Date.now(),
  /**
   * The CURRENT resolved hot owner. An event is "finished" only when THIS
   * recipient has terminal rows on both channels, so an owner change re-opens
   * it for the new owner. null (unresolved) → any recipient counts (nothing
   * is sent without a resolved owner anyway).
   */
  currentOwner: string | null = null,
): Promise<{ promotions: HotPromotion[]; complete: boolean }> {
  type Row = {
    id: string;
    property_id: string;
    source_type: string;
    source_id: string;
    payload: { to?: unknown; inbound?: unknown; covered_by_hold?: unknown; held_lead?: unknown; escalation?: unknown } | null;
    created_at: string;
  };
  const sinceMs = Math.max(Date.parse(alertsSince), nowMs - HOT_ALERT_LOOKBACK_MS);
  const since = new Date(Number.isFinite(sinceMs) ? sinceMs : nowMs - HOT_ALERT_LOOKBACK_MS).toISOString();
  const rows: Row[] = [];
  let complete = true;
  let before: { at: string; id: string } | null = null;
  for (;;) {
    let q = db
      .from("lead_events")
      .select("id, property_id, source_type, source_id, payload, created_at")
      .eq("org_id", orgId)
      .in("source_type", [HOT_HANDOFF_SOURCE_TYPE, HOT_TEXT_SOURCE_TYPE, HOT_FAILED_SOURCE_TYPE])
      .gte("created_at", since);
    if (before) q = q.or(`created_at.lt.${before.at},and(created_at.eq.${before.at},id.lt.${before.id})`);
    const { data, error } = await q
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(HOT_PROMOTION_PAGE);
    if (error) return { promotions: [], complete: false };
    const page = (data ?? []) as Row[];
    rows.push(...page);
    if (page.length < HOT_PROMOTION_PAGE) break;
    const last = page[page.length - 1]!;
    before = { at: last.created_at, id: last.id };
  }
  const keyOf = (r: Row) =>
    r.source_type === HOT_TEXT_SOURCE_TYPE
      ? hotTextKey(r.source_id)
      : r.source_type === HOT_FAILED_SOURCE_TYPE
        ? typeof (r.payload as { flag_at?: unknown } | null)?.flag_at === "string"
          ? hotFlagKey(r.property_id, (r.payload as { flag_at: string }).flag_at)
          : hotFailedKey(r.source_id)
        : hotHandoffKey(r.source_id);
  // Finished keys (both channels sent, skipped, or out of attempts) drop out before any task is built.
  const done = new Set<string>();
  const keys = [...new Set(rows.map(keyOf))];
  for (let i = 0; i < keys.length; i += HOT_PROMOTION_PAGE) {
    const { data, error } = await db
      .from("hold_alert_deliveries")
      .select("hold_key, channel, status, attempts, recipient_user_id")
      .eq("org_id", orgId)
      .in("hold_key", keys.slice(i, i + HOT_PROMOTION_PAGE));
    if (error) {
      complete = false;
      continue;
    }
    const finished = new Map<string, Set<string>>();
    for (const d of (data ?? []) as Array<{ hold_key: string; channel: string; status: string; attempts: number; recipient_user_id: string }>) {
      if (currentOwner && d.recipient_user_id !== currentOwner) continue;
      const isDone = d.status === "sent" || d.status === "skipped" || (d.status === "failed" && d.attempts >= MAX_ATTEMPTS);
      if (!isDone) continue;
      const set = finished.get(d.hold_key) ?? new Set<string>();
      set.add(d.channel);
      finished.set(d.hold_key, set);
    }
    for (const [k, set] of finished) if (set.has("slack") && set.has("sms")) done.add(k);
  }
  const todo0 = rows.filter((r) => !done.has(keyOf(r)));
  // A hot event's moment is its INBOUND text's arrival, never when the event
  // row was written (a pre-cutoff text retried later must not page). Every
  // event's source_id is that inbound; no verifiable time → dropped (fail closed).
  const inboundAt = new Map<string, string>();
  const inboundIds = [...new Set(todo0.map((r) => r.source_id))];
  for (let i = 0; i < inboundIds.length; i += HOT_PROMOTION_PAGE) {
    const { data, error } = await db
      .from("messages")
      .select("id, created_at")
      .eq("org_id", orgId)
      .in("id", inboundIds.slice(i, i + HOT_PROMOTION_PAGE));
    if (error) {
      complete = false;
      continue;
    }
    for (const m of (data ?? []) as Array<{ id: string; created_at: string | null }>) if (m.created_at) inboundAt.set(m.id, m.created_at);
  }
  const todo = todo0.filter((r) => inboundAt.has(r.source_id));
  if (todo.length < todo0.length) complete = false;
  const ids = [...new Set(todo.map((r) => r.property_id))];
  const names = new Map<string, string>();
  const addresses = new Map<string, string>();
  for (let i = 0; i < ids.length; i += HOT_PROMOTION_PAGE) {
    const { data: props, error: propError } = await db
      .from("properties")
      .select("id, address, city, assigned_user_id, contacts:homeowner_contact_id(first_name)")
      .in("id", ids.slice(i, i + HOT_PROMOTION_PAGE));
    if (propError) complete = false;
    for (const p of (props ?? []) as Array<{ id: string; address: string | null; city: string | null; assigned_user_id: string | null; contacts: { first_name: string | null } | null }>) {
      const first = p.contacts?.first_name?.trim();
      if (first) names.set(p.id, first);
      const addr = [p.address?.trim(), p.city?.trim()].filter(Boolean).join(", ");
      if (addr) addresses.set(p.id, addr);
    }
  }
  const promotions: HotPromotion[] = [];
  for (const r of todo) {
    const failed = r.source_type === HOT_FAILED_SOURCE_TYPE;
    const to = typeof r.payload?.to === "string" ? r.payload.to : null;
    if (!to && !failed) continue;
    // An open hot hold already pinged Jarrad about this lead.
    if (r.payload?.covered_by_hold === true) continue;
    // Assignment never gates a hot alert (owner decision 2026-10-19): Jarrad gets it whoever has the lead.
    promotions.push({
      propertyId: r.property_id,
      assigneeUserId: to ?? "",
      name: names.get(r.property_id) ?? "Unknown sender",
      assignedAt: inboundAt.get(r.source_id) as string,
      kind: r.source_type === HOT_TEXT_SOURCE_TYPE ? "hot_text" : failed ? "hot_failed" : "handoff",
      ...(r.payload?.held_lead === true ? { heldLead: true } : {}),
      ...(failed && typeof (r.payload as { reason?: unknown } | null)?.reason === "string"
        ? { reason: (r.payload as { reason: string }).reason }
        : {}),
      address: r.source_type === HOT_TEXT_SOURCE_TYPE ? (addresses.get(r.property_id) ?? null) : null,
      key: keyOf(r),
    });
  }
  return { promotions, complete };
}

export function createHoldAlertDeps(
  admin: SupabaseClient<Database>,
  env: Record<string, string | undefined> = process.env,
): HoldAlertDeps {
  const db = admin as unknown as LooseSupabase;
  const senders = createChannelSenders(admin, { env });
  const now = () => new Date();
  return {
    now,
    store: createSupabaseDeliveryStore(db),
    baseUrl: resolveAppBaseUrl(env),
    emailEnabled: env.HOLD_ALERT_EMAIL_ENABLED === "1",
    loadHolds: (orgId, alertsSince) =>
      loadAlertHolds(db, orgId, alertsSince, now().getTime()),
    loadHeldPropertyIds: (orgId, ids) => loadHeldPropertyIds(db, orgId, ids),
    async loadHotPromotions(orgId, alertsSince) {
      const owner = await resolveHotOwner(admin, orgId, env).catch(() => null);
      return loadHotPromotions(db, orgId, alertsSince, now().getTime(), owner);
    },
    async loadLeadReplies(orgId, alertsSince) {
      const owner = await resolveHotOwner(admin, orgId, env).catch(() => null);
      return loadLeadReplies(db, orgId, alertsSince, now().getTime(), owner);
    },
    loadHotOwner: (orgId) => resolveHotOwner(admin, orgId, env),
    async loadRecipients(orgId): Promise<Recipient[]> {
      const { data, error } = await db
        .from("memberships")
        .select(MEMBERSHIP_COLUMNS)
        .eq("org_id", orgId);
      if (error) throw new Error(`memberships lookup failed: ${error.message}`);
      return ((data ?? []) as MembershipRow[])
        .filter(isHoldAlertRecipient)
        .map((m) => ({ userId: m.user_id, role: m.role }));
    },
    async isRecipientAuthorized(orgId, userId, opts) {
      const { data, error } = await db
        .from("memberships")
        .select(MEMBERSHIP_COLUMNS)
        .eq("org_id", orgId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error)
        throw new Error(`membership re-check failed: ${error.message}`);
      if (!data) return false;
      const m = data as MembershipRow;
      if (!isHoldAlertRecipient(m)) return false;
      return opts?.requireOwner ? m.role === "owner" : true;
    },
    ...senders,
  };
}

/** Kill switch: alerts send only when HOLD_ALERTS_ENABLED is exactly "1". Default off. */
export function holdAlertsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.HOLD_ALERTS_ENABLED === "1";
}

export type AllOrgsSummary = Omit<OrgAlertSummary, "budgetExhausted"> & {
  /** True when the kill switch was off: nothing was read or sent. */
  disabled?: boolean;
  orgs: number;
  errors: number;
  budgetExhausted: boolean;
};

/** Orgs with an active ai_responder_configs row, processed one at a time within a shared budget. */
export async function runHoldAlertsForAllOrgs(
  admin: SupabaseClient<Database>,
  opts: {
    budgetMs?: number;
    onError?: (error: unknown, orgId: string) => void;
    env?: Record<string, string | undefined>;
    log?: (message: string) => void;
  } = {},
): Promise<AllOrgsSummary> {
  const env = opts.env ?? process.env;
  if (!holdAlertsEnabled(env)) {
    (opts.log ?? ((m: string) => console.warn(m)))(
      "hold alerts skipped: HOLD_ALERTS_ENABLED is not 1",
    );
    return {
      disabled: true,
      orgs: 0,
      holds: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      untouched: 0,
      deferred: 0,
      interrupted: 0,
      archived: 0,
      errors: 0,
      budgetExhausted: false,
      hotOwnerUnknown: false,
    };
  }
  const db = admin as unknown as LooseSupabase;
  const { data, error } = await db
    .from("ai_responder_configs")
    .select("org_id")
    .eq("active", true);
  if (error)
    throw new Error(`ai_responder_configs lookup failed: ${error.message}`);
  const orgIds = [
    ...new Set(
      ((data ?? []) as Array<{ org_id: string }>).map((r) => r.org_id),
    ),
  ];

  const deps = createHoldAlertDeps(admin, env);
  const total: AllOrgsSummary = {
    orgs: orgIds.length,
    holds: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    untouched: 0,
    deferred: 0,
    interrupted: 0,
    archived: 0,
    errors: 0,
    budgetExhausted: false,
    hotOwnerUnknown: false,
  };
  const startMs = Date.now();
  const budgetMs = opts.budgetMs ?? 50_000;
  for (const orgId of orgIds) {
    const remaining = budgetMs - (Date.now() - startMs);
    if (remaining <= 0) {
      total.budgetExhausted = true;
      break;
    }
    try {
      const s = await runHoldAlertsForOrg(deps, orgId, { budgetMs: remaining });
      total.holds += s.holds;
      total.sent += s.sent;
      total.skipped += s.skipped;
      total.failed += s.failed;
      total.untouched += s.untouched;
      total.deferred += s.deferred;
      total.interrupted += s.interrupted;
      total.archived += s.archived;
      total.budgetExhausted ||= s.budgetExhausted;
      total.hotOwnerUnknown ||= s.hotOwnerUnknown;
    } catch (e) {
      total.errors += 1;
      opts.onError?.(e, orgId);
    }
  }
  return total;
}
