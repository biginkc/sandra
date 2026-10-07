import type { SupabaseClient } from "@supabase/supabase-js";

import { loadMessagesV2Data, type LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { loadRunLabels } from "@/app/(dashboard)/messages-v2/labels";
import { hasActiveSandraAccess } from "@/lib/auth/access-state";
import { isAcquisitionsCaller } from "@/lib/auth/surface-access";
import type { Database } from "@/lib/supabase/types";

import { createChannelSenders } from "./channels";
import { runHoldAlertsForOrg } from "./core";
import { toAlertHolds } from "./holds";
import { createSupabaseDeliveryStore } from "./store";
import type { HoldAlertDeps, HoldInfo, OrgAlertSummary, Recipient } from "./types";

export { HOT_HOLD_REASONS } from "./holds";
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
  return hasActiveSandraAccess(m) && (m.role === "owner" || isAcquisitionsCaller(m));
}

export function resolveAppBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw =
    env.NEXT_PUBLIC_APP_URL ?? env.VERCEL_PROJECT_PRODUCTION_URL ?? "https://sandra-sooty.vercel.app";
  return (raw.startsWith("http") ? raw : `https://${raw}`).replace(/\/+$/, "");
}

/**
 * Open holds from the SAME derivation as the page. The run window the page
 * loader selects includes inbound_preview; it is dropped here (hold -> HoldInfo
 * keeps ids, first name, address only) and never reaches an alert payload.
 */
async function loadAlertHolds(db: LooseSupabase, orgId: string): Promise<HoldInfo[]> {
  const data = await loadMessagesV2Data(db, orgId);
  const labels = await loadRunLabels(
    db,
    data.holds.map((h) => ({
      id: h.id,
      contact_id: h.run?.contact_id ?? null,
      property_id: h.property_id,
      inbound_message_id: h.run?.inbound_message_id ?? "",
    })),
  );
  return toAlertHolds(data.holds, labels);
}

export function createHoldAlertDeps(
  admin: SupabaseClient<Database>,
  env: Record<string, string | undefined> = process.env,
): HoldAlertDeps {
  const db = admin as unknown as LooseSupabase;
  const senders = createChannelSenders(admin, { env });
  return {
    now: () => new Date(),
    store: createSupabaseDeliveryStore(db),
    baseUrl: resolveAppBaseUrl(env),
    emailEnabled: env.HOLD_ALERT_EMAIL_ENABLED === "1",
    loadHolds: (orgId) => loadAlertHolds(db, orgId),
    async loadRecipients(orgId): Promise<Recipient[]> {
      const { data, error } = await db.from("memberships").select(MEMBERSHIP_COLUMNS).eq("org_id", orgId);
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
      if (error) throw new Error(`membership re-check failed: ${error.message}`);
      if (!data) return false;
      const m = data as MembershipRow;
      if (!isHoldAlertRecipient(m)) return false;
      return opts?.requireOwner ? m.role === "owner" : true;
    },
    ...senders,
  };
}

export type AllOrgsSummary = Omit<OrgAlertSummary, "budgetExhausted"> & {
  orgs: number;
  errors: number;
  budgetExhausted: boolean;
};

/** Orgs with an active ai_responder_configs row, processed one at a time within a shared budget. */
export async function runHoldAlertsForAllOrgs(
  admin: SupabaseClient<Database>,
  opts: { budgetMs?: number; onError?: (error: unknown, orgId: string) => void } = {},
): Promise<AllOrgsSummary> {
  const db = admin as unknown as LooseSupabase;
  const { data, error } = await db.from("ai_responder_configs").select("org_id").eq("active", true);
  if (error) throw new Error(`ai_responder_configs lookup failed: ${error.message}`);
  const orgIds = [...new Set(((data ?? []) as Array<{ org_id: string }>).map((r) => r.org_id))];

  const deps = createHoldAlertDeps(admin);
  const total: AllOrgsSummary = {
    orgs: orgIds.length,
    holds: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    untouched: 0,
    deferred: 0,
    interrupted: 0,
    errors: 0,
    budgetExhausted: false,
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
      total.budgetExhausted ||= s.budgetExhausted;
    } catch (e) {
      total.errors += 1;
      opts.onError?.(e, orgId);
    }
  }
  return total;
}
