import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

import type { ContractProjectionView } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

/**
 * Latest projection for a lead, read with the service role AFTER the caller proved the lead is in
 * their own queue (the actions do that first). Returns null when there is none or the read fails.
 */
export async function loadProjectionView(
  orgId: string,
  propertyId: string,
  admin: Loose = createAdminClient(),
): Promise<ContractProjectionView | null> {
  try {
    const latest = await admin
      .from("acquisition_offer_projections")
      .select("id, state, conflict_code, esign_request_id, amount_cents, follow_up_at")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .order("created_at", { ascending: false })
      .limit(1);
    const row = (latest.error ? null : (latest.data as Record<string, unknown>[] | null)?.[0]) ?? null;
    if (!row) return null;
    let sendUnknown = false;
    if (row.esign_request_id) {
      const req = await admin.from("esign_requests").select("delivery_state").eq("id", row.esign_request_id).eq("org_id", orgId).maybeSingle();
      sendUnknown = !req.error && req.data?.delivery_state === "send_unknown";
    }
    let pendingOfferAmountCents: number | null = null;
    if (row.state === "conflict" && row.conflict_code === "PENDING_OFFER_EXISTS") {
      const o = await admin.from("acquisition_offers").select("amount_cents").eq("org_id", orgId).eq("property_id", propertyId).eq("outcome", "pending").limit(1);
      const v = !o.error ? (o.data as { amount_cents: number | string }[] | null)?.[0]?.amount_cents : null;
      pendingOfferAmountCents = v == null ? null : Number(v);
    }
    return {
      id: String(row.id),
      state: row.state as ContractProjectionView["state"],
      conflictCode: (row.conflict_code as string | null) ?? null,
      requestId: (row.esign_request_id as string | null) ?? null,
      sendUnknown,
      amountCents: Number(row.amount_cents),
      followUpAt: (row.follow_up_at as string | null) ?? null,
      pendingOfferAmountCents,
    };
  } catch {
    return null;
  }
}
