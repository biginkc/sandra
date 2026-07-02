import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Delivery-catalog seeding for integration tests.
 *
 * The Dynamic Sender feature validates campaign senders against the
 * synced `provider_sender_numbers` catalog and (at release time) fails
 * closed when a queued row's `from_address` is not an active approved
 * sender. `reset_tenant_tables()` truncates the catalog tables, so any
 * test that queues + releases (or creates a campaign) must seed the
 * catalog first. The service-role client bypasses RLS (the catalog is
 * select-only for authenticated users).
 */

/** The two numbers the mock provider reports from listPurchasedNumbers(). */
export const MOCK_SENDER_PRIMARY = "+15551234567";
export const MOCK_SENDER_SECONDARY = "+15559999999";
/** The provider campaign the mock provider reports from listProviderCampaigns(). */
export const MOCK_PROVIDER_CAMPAIGN_ID = "mock-provider-campaign-1";

export async function seedSenderCatalog(
  serviceClient: SupabaseClient<Database>,
  orgId: string,
  phones: string[] = [MOCK_SENDER_PRIMARY],
  opts: { provider?: string; status?: "active" | "inactive" } = {},
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await serviceClient.from("provider_sender_numbers").upsert(
    phones.map((phone) => ({
      org_id: orgId,
      provider: opts.provider ?? "mock",
      phone_e164: phone,
      status: opts.status ?? "active",
      last_synced_at: nowIso,
      updated_at: nowIso,
    })),
    { onConflict: "org_id,provider,phone_e164" },
  );
  if (error) throw new Error(`seedSenderCatalog failed: ${error.message}`);
}

export async function seedProviderCampaignCatalog(
  serviceClient: SupabaseClient<Database>,
  orgId: string,
  externalIds: string[] = [MOCK_PROVIDER_CAMPAIGN_ID],
  opts: { provider?: string; status?: "active" | "inactive"; name?: string } = {},
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error } = await serviceClient.from("provider_campaigns").upsert(
    externalIds.map((externalId) => ({
      org_id: orgId,
      provider: opts.provider ?? "mock",
      external_id: externalId,
      name: opts.name ?? `Catalog campaign ${externalId}`,
      status: opts.status ?? "active",
      last_synced_at: nowIso,
      updated_at: nowIso,
    })),
    { onConflict: "org_id,provider,external_id" },
  );
  if (error) {
    throw new Error(`seedProviderCampaignCatalog failed: ${error.message}`);
  }
}
