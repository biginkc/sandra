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
 *  - Release-time validation fails closed: unknown/inactive senders fail the
 *    row loudly. Never-synced inventory is deferred, not terminal-failed, so
 *    first deploys cannot mass-kill the queue before the first catalog sync.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import { reportError } from "@/lib/errors/report";
import { ok, type Result } from "@/lib/errors/result";
import type { Database, Json } from "@/lib/supabase/types";
import { getMessagingProvider } from "./registry";
import type { MessagingProvider } from "./types";

type Supabase = SupabaseClient<Database>;
const catalogSyncInflight = new Map<string, Promise<CatalogSyncResult>>();

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

  const syncKey = `${orgId}:${provider.providerId}`;
  const inflight = catalogSyncInflight.get(syncKey);
  if (inflight) return inflight;

  const sync = syncProviderCatalogOnce(client, orgId, provider).finally(() => {
    catalogSyncInflight.delete(syncKey);
  });
  catalogSyncInflight.set(syncKey, sync);
  return sync;
}

async function syncProviderCatalogOnce(
  client: Supabase,
  orgId: string,
  provider: MessagingProvider,
): Promise<CatalogSyncResult> {
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
    // Upsert by E.164 phone intentionally: queued messages and release
    // validation store the sender phone, Sendillo's OpenAPI only promises an
    // object response for purchased numbers, and provider_number_id can be
    // absent. The provider id is still stored for audit/diagnostics.
    const { error } = await client
      .from("provider_sender_numbers")
      .upsert(senderRows, { onConflict: "org_id,provider,phone_e164" });
    if (error) {
      throw new Error(`sender catalog upsert failed: ${error.message}`);
    }
  }
  {
    const { count: activeSenderCount, error: activeSenderError } = await client
      .from("provider_sender_numbers")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("provider", provider.providerId)
      .eq("status", "active");
    if (activeSenderError) {
      throw new Error(
        `sender catalog active-count read failed: ${activeSenderError.message}`,
      );
    }
    if (senderRows.length === 0 && (activeSenderCount ?? 0) > 0) {
      const error = new Error(
        `sender catalog sync returned zero ${provider.providerId} purchased numbers; refusing to deactivate ${activeSenderCount} active sender(s)`,
      );
      reportError(error, {
        tags: { surface: "provider_catalog_sync_mass_deactivation_guard" },
        extra: { orgId, provider: provider.providerId, activeSenderCount },
      });
      throw error;
    }

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
  fromAddress: string;
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
      fromAddress: senderNumber,
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
    fromAddress: senderNumber,
    providerCampaignExternalId: providerCampaign.external_id,
    providerCampaignName: providerCampaign.name,
  });
}

export type CampaignDeliverySettings = {
  senderProvider: string | null;
  senderNumber: string | null;
  fromAddress: string | null;
  providerCampaignExternalId: string | null;
  providerCampaignName: string | null;
};

export async function persistCampaignDeliverySettings(
  client: Supabase,
  args: {
    campaignId: string;
    orgId: string;
    delivery: ResolvedDeliverySelection;
  },
): Promise<Result<null>> {
  const fromAddress = normalizeSenderNumber(args.delivery.fromAddress);

  const { error } = await client.rpc("persist_campaign_delivery_settings", {
    p_campaign_id: args.campaignId,
    p_org_id: args.orgId,
    p_provider: args.delivery.senderProvider,
    p_sender_number: args.delivery.senderNumber,
    p_from_address: fromAddress,
    p_provider_campaign_id: args.delivery.providerCampaignExternalId,
    p_provider_campaign_name: args.delivery.providerCampaignName,
  });
  if (error) {
    return {
      ok: false,
      error: {
        code: "DELIVERY_SETTINGS_SAVE_FAILED",
        message: error.message,
      },
    };
  }

  return ok(null);
}

export async function loadCampaignDeliverySettings(
  client: Supabase,
  campaignId: string,
): Promise<CampaignDeliverySettings> {
  const { data: settings, error: settingsError } = await client
    .from("campaign_delivery_settings")
    .select(
      "provider, sender_number, from_address, provider_campaign_id, provider_campaign_name",
    )
    .eq("campaign_id", campaignId)
    .maybeSingle();
  if (settingsError) {
    throw new Error(`campaign delivery settings read failed: ${settingsError.message}`);
  }
  if (settings) {
    return {
      senderProvider: settings.provider,
      senderNumber: settings.sender_number,
      fromAddress: settings.from_address,
      providerCampaignExternalId: settings.provider_campaign_id,
      providerCampaignName: settings.provider_campaign_name,
    };
  }

  const { data: campaign, error: campaignError } = await client
    .from("campaigns")
    .select(
      "sender_provider, sender_number, provider_campaign_external_id, provider_campaign_name",
    )
    .eq("id", campaignId)
    .maybeSingle();
  if (campaignError) {
    throw new Error(`campaign delivery read failed: ${campaignError.message}`);
  }
  return {
    senderProvider: campaign?.sender_provider ?? null,
    senderNumber: campaign?.sender_number ?? null,
    fromAddress: campaign?.sender_number ?? null,
    providerCampaignExternalId: campaign?.provider_campaign_external_id ?? null,
    providerCampaignName: campaign?.provider_campaign_name ?? null,
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
