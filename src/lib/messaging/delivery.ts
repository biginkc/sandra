/**
 * Provider-neutral delivery setup: synced sender-number / provider-campaign
 * catalog plus the sender rules campaigns queue under.
 *
 * Invariants (approved plan "Sandra Dynamic Sender + Provider-Neutral
 * Delivery Setup"):
 *  - The catalog is read-only sync from the provider — no purchase/create/
 *    attach mutations ever originate here.
 *  - Campaigns snapshot the literal sender (provider + E.164); queued
 *    messages stamp from_address. Neither depends on live catalog rows.
 *  - Catalog rows are soft-deactivated when they drop out of a sync,
 *    never deleted, so historical senders stay auditable.
 *  - Release-time validation fails closed: unknown/inactive senders fail
 *    the row loudly; an empty (never-synced) inventory defers the row
 *    without terminal failure so a sync can unblock it. There is no
 *    fallback to an env-default sender.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { ok, type Result } from "@/lib/errors/result";
import type { Database, Json } from "@/lib/supabase/types";
import { getMessagingProvider } from "./registry";
import type { MessagingProvider } from "./types";

type Supabase = SupabaseClient<Database>;

export type DeliverySenderOption = {
  phoneE164: string;
  provider: string;
  status: string;
  messagingStatus: string | null;
  lastSyncedAt: string;
};

export type DeliveryProviderCampaignOption = {
  externalId: string;
  provider: string;
  name: string | null;
  brand: string | null;
  useCase: string | null;
  status: string;
  lastSyncedAt: string;
};

export type DeliveryCatalog = {
  provider: string | null;
  senders: DeliverySenderOption[];
  providerCampaigns: DeliveryProviderCampaignOption[];
  lastSyncedAt: string | null;
};

export type CatalogSyncResult =
  | {
      supported: true;
      provider: string;
      senderCount: number;
      providerCampaignCount: number;
    }
  | { supported: false; provider: string | null };

/** Providers that participate in sender-inventory validation are the ones
 *  that can report their purchased numbers. */
export function providerSupportsSenderInventory(
  provider: Pick<MessagingProvider, "listPurchasedNumbers">,
): boolean {
  return typeof provider.listPurchasedNumbers === "function";
}

export function normalizeSenderNumber(value: string): string {
  return normalizePhone(value) ?? value.trim();
}

/**
 * Pull the provider's sender-number and provider-campaign catalogs and
 * upsert them by stable key. Rows that disappeared from the provider are
 * soft-deactivated. `client` must be the admin client — the catalog
 * tables are select-only under RLS.
 */
export async function syncProviderCatalog(
  client: Supabase,
  orgId: string,
): Promise<CatalogSyncResult> {
  const provider = getMessagingProvider();
  if (!provider || !providerSupportsSenderInventory(provider)) {
    return { supported: false, provider: provider?.providerId ?? null };
  }

  const nowIso = new Date().toISOString();

  const purchased = await provider.listPurchasedNumbers!();
  const seenPhones = new Set<string>();
  const senderRows = [];
  for (const entry of purchased) {
    const phone = normalizeSenderNumber(entry.phoneE164);
    if (!phone || seenPhones.has(phone)) continue;
    seenPhones.add(phone);
    senderRows.push({
      org_id: orgId,
      provider: provider.providerId,
      phone_e164: phone,
      provider_number_id: entry.providerNumberId,
      status: "active",
      messaging_status: entry.messagingStatus ?? entry.status,
      raw: (entry.raw ?? null) as Json,
      last_synced_at: nowIso,
      updated_at: nowIso,
    });
  }
  if (senderRows.length > 0) {
    const { error } = await client
      .from("provider_sender_numbers")
      .upsert(senderRows, { onConflict: "org_id,provider,phone_e164" });
    if (error) {
      throw new Error(`sender catalog upsert failed: ${error.message}`);
    }
  }
  {
    // Soft-deactivate rows the provider no longer reports.
    const { error } = await client
      .from("provider_sender_numbers")
      .update({ status: "inactive", updated_at: nowIso })
      .eq("org_id", orgId)
      .eq("provider", provider.providerId)
      .lt("last_synced_at", nowIso)
      .eq("status", "active");
    if (error) {
      throw new Error(`sender catalog deactivate failed: ${error.message}`);
    }
  }

  let providerCampaignCount = 0;
  if (typeof provider.listProviderCampaigns === "function") {
    const providerCampaigns = await provider.listProviderCampaigns();
    const seenIds = new Set<string>();
    const campaignRows = [];
    for (const entry of providerCampaigns) {
      const externalId = entry.externalId.trim();
      if (!externalId || seenIds.has(externalId)) continue;
      seenIds.add(externalId);
      campaignRows.push({
        org_id: orgId,
        provider: provider.providerId,
        external_id: externalId,
        name: entry.name,
        brand: entry.brand,
        use_case: entry.useCase,
        status: "active",
        provider_status: entry.status,
        raw: (entry.raw ?? null) as Json,
        last_synced_at: nowIso,
        updated_at: nowIso,
      });
    }
    if (campaignRows.length > 0) {
      const { error } = await client
        .from("provider_campaigns")
        .upsert(campaignRows, { onConflict: "org_id,provider,external_id" });
      if (error) {
        throw new Error(`provider campaign upsert failed: ${error.message}`);
      }
    }
    const { error } = await client
      .from("provider_campaigns")
      .update({ status: "inactive", updated_at: nowIso })
      .eq("org_id", orgId)
      .eq("provider", provider.providerId)
      .lt("last_synced_at", nowIso)
      .eq("status", "active");
    if (error) {
      throw new Error(
        `provider campaign deactivate failed: ${error.message}`,
      );
    }
    providerCampaignCount = campaignRows.length;
  }

  return {
    supported: true,
    provider: provider.providerId,
    senderCount: senderRows.length,
    providerCampaignCount,
  };
}

/**
 * Read the synced catalog for the current provider — what the Delivery
 * selectors render. Never calls the provider.
 */
export async function loadDeliveryCatalog(
  client: Supabase,
  orgId: string,
): Promise<DeliveryCatalog> {
  const provider = getMessagingProvider();
  if (!provider || !providerSupportsSenderInventory(provider)) {
    return {
      provider: provider?.providerId ?? null,
      senders: [],
      providerCampaigns: [],
      lastSyncedAt: null,
    };
  }

  const [sendersResult, campaignsResult] = await Promise.all([
    client
      .from("provider_sender_numbers")
      .select("phone_e164, provider, status, messaging_status, last_synced_at")
      .eq("org_id", orgId)
      .eq("provider", provider.providerId)
      .eq("status", "active")
      .order("phone_e164"),
    client
      .from("provider_campaigns")
      .select(
        "external_id, provider, name, brand, use_case, status, last_synced_at",
      )
      .eq("org_id", orgId)
      .eq("provider", provider.providerId)
      .eq("status", "active")
      .order("name"),
  ]);
  if (sendersResult.error) {
    throw new Error(
      `delivery catalog senders read failed: ${sendersResult.error.message}`,
    );
  }
  if (campaignsResult.error) {
    throw new Error(
      `delivery catalog provider campaigns read failed: ${campaignsResult.error.message}`,
    );
  }

  const senders: DeliverySenderOption[] = (sendersResult.data ?? []).map(
    (row) => ({
      phoneE164: row.phone_e164,
      provider: row.provider,
      status: row.status,
      messagingStatus: row.messaging_status,
      lastSyncedAt: row.last_synced_at,
    }),
  );
  const providerCampaigns: DeliveryProviderCampaignOption[] = (
    campaignsResult.data ?? []
  ).map((row) => ({
    externalId: row.external_id,
    provider: row.provider,
    name: row.name,
    brand: row.brand,
    useCase: row.use_case,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
  }));

  const lastSyncedAt =
    [...senders, ...providerCampaigns]
      .map((row) => row.lastSyncedAt)
      .sort()
      .at(-1) ?? null;

  return {
    provider: provider.providerId,
    senders,
    providerCampaigns,
    lastSyncedAt,
  };
}

export type SenderInventoryState =
  | { state: "approved" }
  | { state: "inactive" }
  | { state: "unknown" }
  /** No synced inventory rows exist for this org+provider at all. */
  | { state: "empty" };

/**
 * Release-guard lookup: is `fromAddress` in the approved (synced, active)
 * sender inventory for this org + provider?
 */
export async function getSenderInventoryState(
  client: Supabase,
  orgId: string,
  providerId: string,
  fromAddress: string,
): Promise<SenderInventoryState> {
  const phone = normalizeSenderNumber(fromAddress);
  const { data, error } = await client
    .from("provider_sender_numbers")
    .select("phone_e164, status")
    .eq("org_id", orgId)
    .eq("provider", providerId);
  if (error) {
    throw new Error(`sender inventory read failed: ${error.message}`);
  }
  const rows = data ?? [];
  if (rows.length === 0) return { state: "empty" };
  const match = rows.find((row) => row.phone_e164 === phone);
  if (!match) return { state: "unknown" };
  return match.status === "active"
    ? { state: "approved" }
    : { state: "inactive" };
}

export type ResolvedDeliverySelection = {
  senderProvider: string;
  senderNumber: string;
  providerCampaignExternalId: string | null;
  providerCampaignName: string | null;
};

/**
 * Validate a Delivery selection against the synced catalog: the sending
 * number must be an active approved sender; the provider campaign (when
 * given) must be an active synced provider campaign. Returns the literal
 * snapshot values persisted onto the campaign row.
 */
export async function resolveDeliverySelection(
  client: Supabase,
  orgId: string,
  senderNumberInput: string,
  providerCampaignExternalId: string | null | undefined,
): Promise<Result<ResolvedDeliverySelection>> {
  const senderNumber = normalizeSenderNumber(senderNumberInput ?? "");
  if (!senderNumber) {
    return {
      ok: false,
      error: {
        code: "SENDER_REQUIRED",
        message: "Choose a sending number before saving.",
      },
    };
  }

  // Scope to the CURRENT provider — a number that is only approved under
  // a previously-configured provider must not be selectable, or queued
  // rows would stamp a sender the active provider can't release.
  let currentProvider: MessagingProvider | null;
  try {
    currentProvider = getMessagingProvider();
  } catch (e) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_LOOKUP_FAILED",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }
  if (!currentProvider) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_LOOKUP_FAILED",
        message:
          "Messaging is off — set MESSAGING_PROVIDER before configuring Delivery.",
      },
    };
  }

  const { data: senderRows, error: senderError } = await client
    .from("provider_sender_numbers")
    .select("provider, phone_e164, status")
    .eq("org_id", orgId)
    .eq("provider", currentProvider.providerId)
    .eq("phone_e164", senderNumber);
  if (senderError) {
    return {
      ok: false,
      error: { code: "DELIVERY_LOOKUP_FAILED", message: senderError.message },
    };
  }
  const activeSender = (senderRows ?? []).find(
    (row) => row.status === "active",
  );
  if (!activeSender) {
    return {
      ok: false,
      error: {
        code: "SENDER_NOT_APPROVED",
        message:
          "Sending number is not in the synced approved sender list. Sync Delivery senders and pick an active number.",
      },
    };
  }

  const externalId =
    typeof providerCampaignExternalId === "string" &&
    providerCampaignExternalId.trim().length > 0
      ? providerCampaignExternalId.trim()
      : null;
  if (!externalId) {
    return ok({
      senderProvider: activeSender.provider,
      senderNumber,
      providerCampaignExternalId: null,
      providerCampaignName: null,
    });
  }

  const { data: providerCampaign, error: campaignError } = await client
    .from("provider_campaigns")
    .select("external_id, name, status")
    .eq("org_id", orgId)
    .eq("provider", activeSender.provider)
    .eq("external_id", externalId)
    .maybeSingle();
  if (campaignError) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_LOOKUP_FAILED",
        message: campaignError.message,
      },
    };
  }
  if (!providerCampaign || providerCampaign.status !== "active") {
    return {
      ok: false,
      error: {
        code: "PROVIDER_CAMPAIGN_NOT_FOUND",
        message:
          "Provider campaign is not in the synced catalog. Re-sync or leave it unset — it is optional.",
      },
    };
  }

  return ok({
    senderProvider: activeSender.provider,
    senderNumber,
    providerCampaignExternalId: providerCampaign.external_id,
    providerCampaignName: providerCampaign.name,
  });
}

export type CampaignDeliverySettings = {
  senderProvider: string | null;
  senderNumber: string | null;
  providerCampaignExternalId: string | null;
  providerCampaignName: string | null;
};

export async function loadCampaignDeliverySettings(
  client: Supabase,
  campaignId: string,
): Promise<CampaignDeliverySettings> {
  const { data, error } = await client
    .from("campaigns")
    .select(
      "sender_provider, sender_number, provider_campaign_external_id, provider_campaign_name",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (error) {
    throw new Error(`campaign delivery read failed: ${error.message}`);
  }
  return {
    senderProvider: data?.sender_provider ?? null,
    senderNumber: data?.sender_number ?? null,
    providerCampaignExternalId: data?.provider_campaign_external_id ?? null,
    providerCampaignName: data?.provider_campaign_name ?? null,
  };
}

/**
 * The sender lock: once a campaign has ANY outbound message row (queued,
 * paused, sent — any status), its sender is immutable. Changing sender
 * after that means a new campaign or a separate audited migration.
 */
export async function campaignHasOutboundMessages(
  client: Supabase,
  campaignId: string,
): Promise<boolean> {
  const { count, error } = await client
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("direction", "outbound");
  if (error) {
    throw new Error(`campaign message count failed: ${error.message}`);
  }
  return (count ?? 0) > 0;
}
