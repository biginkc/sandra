import { beforeEach, describe, expect, it } from "vitest";

import {
  getSenderInventoryState,
  loadDeliveryCatalog,
  resolveDeliverySelection,
  syncProviderCatalog,
} from "@/lib/messaging/delivery";
import {
  resetMockState,
  setMockPurchasedNumbers,
  setMockProviderCampaigns,
} from "@/lib/messaging/providers/mock";
import { createTestClient } from "@tests/integration/client";
import {
  MOCK_PROVIDER_CAMPAIGN_ID,
  MOCK_SENDER_PRIMARY,
  MOCK_SENDER_SECONDARY,
  seedProviderCampaignCatalog,
  seedSenderCatalog,
} from "@tests/integration/delivery";
import { resetTenantTables } from "@tests/integration/reset";

// MESSAGING_PROVIDER=mock comes from vitest.integration.config.ts, so
// syncProviderCatalog syncs the MockMessagingProvider's catalog:
//   numbers   +15551234567, +15559999999 (both active)
//   campaigns mock-provider-campaign-1

const supabase = createTestClient();

async function getOrgId(): Promise<string> {
  const { data, error } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error(`org lookup failed: ${error?.message ?? "no org"}`);
  }
  return data.id;
}

async function listSenderRows(orgId: string) {
  const { data, error } = await supabase
    .from("provider_sender_numbers")
    .select("phone_e164, provider, status, last_synced_at")
    .eq("org_id", orgId)
    .order("phone_e164");
  if (error) throw new Error(error.message);
  return data ?? [];
}

async function listProviderCampaignRows(orgId: string) {
  const { data, error } = await supabase
    .from("provider_campaigns")
    .select("external_id, provider, status, name, last_synced_at")
    .eq("org_id", orgId)
    .order("external_id");
  if (error) throw new Error(error.message);
  return data ?? [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("syncProviderCatalog (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    resetMockState();
  });

  it("upserts the mock provider's numbers and campaigns, idempotently across two runs", async () => {
    const orgId = await getOrgId();

    const first = await syncProviderCatalog(supabase, orgId);
    expect(first).toEqual({
      supported: true,
      provider: "mock",
      senderCount: 2,
      providerCampaignCount: 1,
    });

    const sendersAfterFirst = await listSenderRows(orgId);
    expect(sendersAfterFirst).toHaveLength(2);
    expect(sendersAfterFirst.map((row) => row.phone_e164)).toEqual([
      MOCK_SENDER_PRIMARY,
      MOCK_SENDER_SECONDARY,
    ]);
    expect(sendersAfterFirst.every((row) => row.status === "active")).toBe(true);

    const campaignsAfterFirst = await listProviderCampaignRows(orgId);
    expect(campaignsAfterFirst).toHaveLength(1);
    expect(campaignsAfterFirst[0]).toMatchObject({
      external_id: MOCK_PROVIDER_CAMPAIGN_ID,
      provider: "mock",
      status: "active",
      name: "Mock 10DLC Campaign",
    });

    const firstSyncedAt = sendersAfterFirst[0].last_synced_at;

    // Re-sync: same catalog → same row COUNT (upsert by stable key, no
    // duplicates) with last_synced_at advanced.
    await sleep(25);
    const second = await syncProviderCatalog(supabase, orgId);
    expect(second).toEqual(first);

    const sendersAfterSecond = await listSenderRows(orgId);
    expect(sendersAfterSecond).toHaveLength(2);
    expect(sendersAfterSecond.every((row) => row.status === "active")).toBe(
      true,
    );
    for (const row of sendersAfterSecond) {
      expect(new Date(row.last_synced_at).getTime()).toBeGreaterThan(
        new Date(firstSyncedAt).getTime(),
      );
    }

    const campaignsAfterSecond = await listProviderCampaignRows(orgId);
    expect(campaignsAfterSecond).toHaveLength(1);
    expect(campaignsAfterSecond[0].status).toBe("active");
  });

  it("soft-deactivates senders that drop out of the provider catalog instead of deleting them", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    // The provider stops reporting the secondary number.
    setMockPurchasedNumbers([
      {
        phoneE164: MOCK_SENDER_PRIMARY,
        providerNumberId: "mock-num-1",
        status: "active",
        messagingStatus: "ready",
        raw: { mock: true },
      },
    ]);
    await sleep(25);
    const resync = await syncProviderCatalog(supabase, orgId);
    expect(resync).toMatchObject({ supported: true, senderCount: 1 });

    const rows = await listSenderRows(orgId);
    // Still two rows — the dropped number is deactivated, never deleted.
    expect(rows).toHaveLength(2);
    const primary = rows.find((row) => row.phone_e164 === MOCK_SENDER_PRIMARY);
    const secondary = rows.find(
      (row) => row.phone_e164 === MOCK_SENDER_SECONDARY,
    );
    expect(primary?.status).toBe("active");
    expect(secondary?.status).toBe("inactive");

    // The catalog the UI reads only surfaces the active sender.
    const catalog = await loadDeliveryCatalog(supabase, orgId);
    expect(catalog.provider).toBe("mock");
    expect(catalog.senders.map((sender) => sender.phoneE164)).toEqual([
      MOCK_SENDER_PRIMARY,
    ]);
  });

  it("soft-deactivates provider campaigns that drop out of the catalog", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    setMockProviderCampaigns([]);
    await sleep(25);
    const resync = await syncProviderCatalog(supabase, orgId);
    expect(resync).toMatchObject({ supported: true, providerCampaignCount: 0 });

    const rows = await listProviderCampaignRows(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      external_id: MOCK_PROVIDER_CAMPAIGN_ID,
      status: "inactive",
    });
  });

  it("a dropped sender reactivates on the next sync that reports it again", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    setMockPurchasedNumbers([
      {
        phoneE164: MOCK_SENDER_PRIMARY,
        providerNumberId: "mock-num-1",
        status: "active",
        messagingStatus: "ready",
        raw: { mock: true },
      },
    ]);
    await sleep(25);
    await syncProviderCatalog(supabase, orgId);

    resetMockState(); // both numbers reported again
    await sleep(25);
    await syncProviderCatalog(supabase, orgId);

    const rows = await listSenderRows(orgId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.status === "active")).toBe(true);
  });
});

describe("resolveDeliverySelection (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    resetMockState();
  });

  it("resolves an active sender with an optional synced provider campaign", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    const result = await resolveDeliverySelection(
      supabase,
      orgId,
      MOCK_SENDER_PRIMARY,
      MOCK_PROVIDER_CAMPAIGN_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      senderProvider: "mock",
      senderNumber: MOCK_SENDER_PRIMARY,
      providerCampaignExternalId: MOCK_PROVIDER_CAMPAIGN_ID,
      providerCampaignName: "Mock 10DLC Campaign",
    });
  });

  it("resolves without a provider campaign — the provider campaign is optional", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    const result = await resolveDeliverySelection(
      supabase,
      orgId,
      MOCK_SENDER_SECONDARY,
      null,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      senderProvider: "mock",
      senderNumber: MOCK_SENDER_SECONDARY,
      providerCampaignExternalId: null,
      providerCampaignName: null,
    });
  });

  it("rejects an unknown sender with SENDER_NOT_APPROVED", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    const result = await resolveDeliverySelection(
      supabase,
      orgId,
      "+15550004242",
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENDER_NOT_APPROVED");
  });

  it("rejects a sender approved only under a different provider with SENDER_NOT_APPROVED", async () => {
    const orgId = await getOrgId();
    // Active catalog row exists, but for a provider that is not the
    // currently configured one (mock) — must not be selectable.
    await seedSenderCatalog(supabase, orgId, ["+15550007777"], {
      provider: "sendillo",
      status: "active",
    });

    const result = await resolveDeliverySelection(
      supabase,
      orgId,
      "+15550007777",
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENDER_NOT_APPROVED");
  });

  it("rejects a soft-deactivated (inactive) sender with SENDER_NOT_APPROVED", async () => {
    const orgId = await getOrgId();
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY], {
      status: "inactive",
    });

    const result = await resolveDeliverySelection(
      supabase,
      orgId,
      MOCK_SENDER_PRIMARY,
      null,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENDER_NOT_APPROVED");
  });

  it("rejects a missing sender with SENDER_REQUIRED", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    const result = await resolveDeliverySelection(supabase, orgId, "  ", null);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENDER_REQUIRED");
  });

  it("rejects a provider campaign that is not in the synced catalog with PROVIDER_CAMPAIGN_NOT_FOUND", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    const result = await resolveDeliverySelection(
      supabase,
      orgId,
      MOCK_SENDER_PRIMARY,
      "not-a-synced-provider-campaign",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PROVIDER_CAMPAIGN_NOT_FOUND");
  });

  it("rejects an inactive provider campaign with PROVIDER_CAMPAIGN_NOT_FOUND", async () => {
    const orgId = await getOrgId();
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY]);
    await seedProviderCampaignCatalog(
      supabase,
      orgId,
      [MOCK_PROVIDER_CAMPAIGN_ID],
      { status: "inactive" },
    );

    const result = await resolveDeliverySelection(
      supabase,
      orgId,
      MOCK_SENDER_PRIMARY,
      MOCK_PROVIDER_CAMPAIGN_ID,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PROVIDER_CAMPAIGN_NOT_FOUND");
  });
});

describe("getSenderInventoryState (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
    resetMockState();
  });

  it("returns approved for an active synced sender", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    const state = await getSenderInventoryState(
      supabase,
      orgId,
      "mock",
      MOCK_SENDER_PRIMARY,
    );
    expect(state).toEqual({ state: "approved" });
  });

  it("returns unknown for a number missing from a non-empty inventory", async () => {
    const orgId = await getOrgId();
    await syncProviderCatalog(supabase, orgId);

    const state = await getSenderInventoryState(
      supabase,
      orgId,
      "mock",
      "+15550004242",
    );
    expect(state).toEqual({ state: "unknown" });
  });

  it("returns inactive for a soft-deactivated sender", async () => {
    const orgId = await getOrgId();
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_SECONDARY], {
      status: "inactive",
    });

    const state = await getSenderInventoryState(
      supabase,
      orgId,
      "mock",
      MOCK_SENDER_SECONDARY,
    );
    expect(state).toEqual({ state: "inactive" });
  });

  it("returns empty when no inventory rows exist for the org + provider", async () => {
    const orgId = await getOrgId();

    const state = await getSenderInventoryState(
      supabase,
      orgId,
      "mock",
      MOCK_SENDER_PRIMARY,
    );
    expect(state).toEqual({ state: "empty" });
  });
});
