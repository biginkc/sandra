import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetMockState } from "@/lib/messaging/providers/mock";
import { EMPTY_AUDIENCE_VALIDATION_MESSAGE } from "@/lib/prospects/effective-audience";
import { createTestClient } from "@tests/integration/client";
import {
  MOCK_PROVIDER_CAMPAIGN_ID,
  MOCK_SENDER_PRIMARY,
  MOCK_SENDER_SECONDARY,
  seedProviderCampaignCatalog,
  seedSenderCatalog,
} from "@tests/integration/delivery";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => testClient,
}));
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>(
    "next/server",
  );
  return { ...actual, after: () => {} };
});

let currentUserId: string | null = null;
let currentEmail: string | null = null;
vi.spyOn(testClient.auth, "getUser").mockImplementation(async () =>
  ({
    data: {
      user:
        currentUserId && currentEmail
          ? ({ id: currentUserId, email: currentEmail } as never)
          : null,
    },
    error: null,
  }) as never,
);

const SAFE_NOW = new Date("2026-06-14T18:00:00Z");
const createdAuthUsers: string[] = [];

 
import {
  archiveCampaign,
  createCampaign,
  launchCampaign,
  unarchiveCampaign,
} from "./actions";
 
import { bulkSmsWorkflow } from "@/workflows/bulk-sms";

function sortIds(ids?: Array<string | null | undefined>): string[] {
  return (ids ?? [])
    .filter((value): value is string => typeof value === "string")
    .sort((left, right) => left.localeCompare(right));
}

async function getOrgId(): Promise<string> {
  const { data } = await testClient
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  if (!data?.id) throw new Error("no org");
  return data.id;
}

async function createAuthUser(email: string): Promise<string> {
  const { data, error } = await testClient.auth.admin.createUser({
    email,
    password: `pw-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`createAuthUser failed: ${error?.message}`);
  }
  createdAuthUsers.push(data.user.id);
  return data.user.id;
}

function uniqueCampaignEmail(label: string): string {
  return `jarrad+${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`;
}

async function seedTag(orgId: string, name: string): Promise<string> {
  const { data, error } = await testClient
    .from("tags")
    .insert({ org_id: orgId, name, color: "#10b981" })
    .select("id")
    .single();
  if (error || !data?.id) throw new Error(`tag seed failed: ${error?.message}`);
  return data.id;
}

async function seedTaggedLead(args: {
  orgId: string;
  tagId?: string;
  address: string;
  phone: string;
}): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact, error: contactError } = await testClient
    .from("contacts")
    .insert({
      org_id: args.orgId,
      contact_type: "person",
      first_name: "Campaign",
      last_name: "Lead",
      phone_1: args.phone,
      phone_1_type: "mobile",
    })
    .select("id")
    .single();
  if (contactError || !contact?.id) {
    throw new Error(`contact seed failed: ${contactError?.message}`);
  }

  const { data: property, error: propertyError } = await testClient
    .from("properties")
    .insert({
      org_id: args.orgId,
      address: args.address,
      state: "MO",
      status: "prospect",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  if (propertyError || !property?.id) {
    throw new Error(`property seed failed: ${propertyError?.message}`);
  }

  if (args.tagId) {
    const { error: tagError } = await testClient.from("property_tags").insert({
      property_id: property.id,
      tag_id: args.tagId,
    });
    if (tagError) throw new Error(`property tag seed failed: ${tagError.message}`);
  }

  return { propertyId: property.id, contactId: contact.id };
}

async function seedCampaign(args: {
  orgId: string;
  audienceSnapshot: Record<string, unknown>;
  archivedAt?: string | null;
  body?: string | null;
  name?: string;
  paceSeconds?: number | null;
  skipIfContacted?: boolean;
  status?: "active" | "launching" | "paused" | "completed" | "archived";
  templateCategory?: string | null;
  /** Delivery snapshot — defaults to the mock provider's primary sender.
   *  Pass null explicitly to seed a legacy (pre-Delivery) campaign. */
  senderNumber?: string | null;
  senderProvider?: string | null;
}): Promise<string> {
  const senderNumber =
    args.senderNumber === undefined ? MOCK_SENDER_PRIMARY : args.senderNumber;
  const senderProvider =
    args.senderProvider === undefined
      ? senderNumber === null
        ? null
        : "mock"
      : args.senderProvider;
  const { data, error } = await testClient
    .from("campaigns")
    .insert({
      org_id: args.orgId,
      name: args.name ?? `Campaign ${Math.random().toString(36).slice(2)}`,
      audience_snapshot: args.audienceSnapshot,
      body: args.body ?? null,
      pace_seconds: args.paceSeconds ?? null,
      skip_if_contacted: args.skipIfContacted ?? false,
      status: args.status ?? "active",
      template_category: args.templateCategory ?? null,
      archived_at: args.archivedAt ?? null,
      sender_number: senderNumber,
      sender_provider: senderProvider,
    } as never)
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(`campaign seed failed: ${error?.message}`);
  }
  return data.id;
}

describe("createCampaign / archiveCampaign / unarchiveCampaign (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    resetMockState();
    currentUserId = null;
    currentEmail = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SAFE_NOW);
    // Delivery setup: createCampaign validates senderNumber against the
    // synced catalog, which the reset just truncated.
    const orgId = await getOrgId();
    await seedSenderCatalog(testClient, orgId, [
      MOCK_SENDER_PRIMARY,
      MOCK_SENDER_SECONDARY,
    ]);
    await seedProviderCampaignCatalog(testClient, orgId);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const id of createdAuthUsers) {
      await testClient.auth.admin.deleteUser(id);
    }
    createdAuthUsers.length = 0;
  });

  it("creates a campaign with the saved audience snapshot and operator fields", async () => {
    const orgId = await getOrgId();
    const email = uniqueCampaignEmail("campaign-create");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const result = await createCampaign({
      name: "Vacant June",
      body: "Checking in from Sandra",
      senderNumber: MOCK_SENDER_PRIMARY,
      providerCampaignExternalId: MOCK_PROVIDER_CAMPAIGN_ID,
      templateCategory: "Opener - Homeowner",
      paceSeconds: 45,
      skipIfContacted: true,
      audience: {
        search: "oak",
        blockStack: [{ id: "vacancy-1", kind: "vacancy", tri: "yes" }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: row } = await testClient
      .from("campaigns")
      .select(
        "org_id, name, channel, body, template_category, pace_seconds, skip_if_contacted, created_by, archived_at, audience_snapshot, sender_provider, sender_number, provider_campaign_external_id, provider_campaign_name",
      )
      .eq("id", result.data.id)
      .single();

    expect(row).toMatchObject({
      org_id: orgId,
      name: "Vacant June",
      channel: "sms",
      body: "Checking in from Sandra",
      template_category: "Opener - Homeowner",
      pace_seconds: 45,
      skip_if_contacted: true,
      created_by: userId,
      archived_at: null,
      sender_provider: "mock",
      sender_number: MOCK_SENDER_PRIMARY,
      provider_campaign_external_id: MOCK_PROVIDER_CAMPAIGN_ID,
      provider_campaign_name: `Catalog campaign ${MOCK_PROVIDER_CAMPAIGN_ID}`,
    });
    expect(row?.audience_snapshot).toEqual({
      search: "oak",
      blockStack: [{ id: "vacancy-1", kind: "vacancy", tri: "yes" }],
    });
  });

  it("defaults omitted saved-campaign pacing to 8 seconds", async () => {
    const orgId = await getOrgId();
    const email = uniqueCampaignEmail("campaign-create-default-pace");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const result = await createCampaign({
      name: "Default Pace",
      body: "Checking in from Sandra",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: null,
      audience: {
        search: "oak",
        blockStack: [{ id: "vacancy-1", kind: "vacancy", tri: "yes" }],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { data: row } = await testClient
      .from("campaigns")
      .select("org_id, pace_seconds")
      .eq("id", result.data.id)
      .single();

    expect(row).toMatchObject({
      org_id: orgId,
      pace_seconds: 8,
    });
  });

  it("rejects saved-campaign pacing outside the supported range", async () => {
    const email = uniqueCampaignEmail("campaign-create-invalid-pace");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    for (const paceSeconds of [1, 601]) {
      const result = await createCampaign({
        name: `Too Fast Saved Campaign ${paceSeconds}`,
        body: "Checking in from Sandra",
        senderNumber: MOCK_SENDER_PRIMARY,
        paceSeconds,
        audience: {
          search: "oak",
          blockStack: [{ id: "vacancy-1", kind: "vacancy", tri: "yes" }],
        },
      });

      expect(result).toEqual({
        ok: false,
        error: {
          code: "VALIDATION",
          message:
            "Saved campaign pacing must be between 2 seconds and 10 minutes.",
        },
      });
    }
  });

  it("rejects create when the saved audience only contains no-op filters", async () => {
    const email = uniqueCampaignEmail("campaign-empty-audience");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const result = await createCampaign({
      name: "Empty Audience",
      body: "Should never save",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 18,
      audience: {
        search: null,
        blockStack: [
          { id: "vacancy-empty", kind: "vacancy", tri: "any" },
          {
            id: "state-empty",
            kind: "state",
            combinator: "any",
            values: [],
          },
        ],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "VALIDATION",
        message: EMPTY_AUDIENCE_VALIDATION_MESSAGE,
      },
    });

    const { count } = await testClient
      .from("campaigns")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("revives an archived duplicate name and overwrites the saved launch config", async () => {
    const email = uniqueCampaignEmail("campaign-revive");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const first = await createCampaign({
      name: "Revive Me",
      body: "First body",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 18,
      skipIfContacted: false,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-old", kind: "vacancy", tri: "yes" }],
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const archived = await archiveCampaign(first.data.id);
    expect(archived.ok).toBe(true);

    const revived = await createCampaign({
      name: "revive me",
      body: "Second body",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 30,
      skipIfContacted: true,
      audience: {
        search: "oak",
        blockStack: [{ id: "vacancy-new", kind: "vacancy", tri: "no" }],
      },
    });
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.data.id).toBe(first.data.id);

    const { data: row } = await testClient
      .from("campaigns")
      .select(
        "status, archived_at, body, pace_seconds, skip_if_contacted, audience_snapshot",
      )
      .eq("id", first.data.id)
      .single();

    expect(row).toMatchObject({
      status: "active",
      archived_at: null,
      body: "Second body",
      pace_seconds: 30,
      skip_if_contacted: true,
    });
    expect(row?.audience_snapshot).toEqual({
      search: "oak",
      blockStack: [{ id: "vacancy-new", kind: "vacancy", tri: "no" }],
    });
  });

  it("revives the most recently archived duplicate when multiple archived matches exist", async () => {
    const orgId = await getOrgId();
    const email = uniqueCampaignEmail("campaign-multi-archive-revive");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const olderId = await seedCampaign({
      orgId,
      name: "Deterministic Revive",
      audienceSnapshot: {
        search: null,
        blockStack: [{ id: "older-vacancy", kind: "vacancy", tri: "yes" }],
      },
      body: "Older archived body",
      status: "archived",
      archivedAt: "2026-06-10T10:00:00.000Z",
    });
    const newerId = await seedCampaign({
      orgId,
      name: "Deterministic Revive",
      audienceSnapshot: {
        search: null,
        blockStack: [{ id: "newer-vacancy", kind: "vacancy", tri: "yes" }],
      },
      body: "Newer archived body",
      status: "archived",
      archivedAt: "2026-06-12T10:00:00.000Z",
    });

    const revived = await createCampaign({
      name: "deterministic revive",
      body: "Fresh body",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 30,
      skipIfContacted: true,
      audience: {
        search: "oak",
        blockStack: [{ id: "revived-vacancy", kind: "vacancy", tri: "no" }],
      },
    });

    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.data.id).toBe(newerId);

    const { data: rows } = await testClient
      .from("campaigns")
      .select("id, status, archived_at, body, pace_seconds, skip_if_contacted")
      .in("id", [olderId, newerId])
      .order("id", { ascending: true });

    const olderRow = rows?.find((row) => row.id === olderId);
    const newerRow = rows?.find((row) => row.id === newerId);

    expect(olderRow).toMatchObject({
      id: olderId,
      status: "archived",
      body: "Older archived body",
    });
    expect(new Date(olderRow?.archived_at ?? "").getTime()).toBe(
      new Date("2026-06-10T10:00:00.000Z").getTime(),
    );
    expect(newerRow).toMatchObject({
      id: newerId,
      status: "active",
      archived_at: null,
      body: "Fresh body",
      pace_seconds: 30,
      skip_if_contacted: true,
    });
  });

  it("returns DUPLICATE_NAME when an active match exists even if archived dupes also exist", async () => {
    const orgId = await getOrgId();
    const email = uniqueCampaignEmail("campaign-active-duplicate");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    await seedCampaign({
      orgId,
      name: "Already Live",
      audienceSnapshot: {
        search: null,
        blockStack: [{ id: "active-vacancy", kind: "vacancy", tri: "yes" }],
      },
      body: "Active body",
      status: "active",
    });
    await seedCampaign({
      orgId,
      name: "Already Live",
      audienceSnapshot: {
        search: null,
        blockStack: [{ id: "archived-vacancy", kind: "vacancy", tri: "no" }],
      },
      body: "Archived body",
      status: "archived",
      archivedAt: "2026-06-13T10:00:00.000Z",
    });

    const result = await createCampaign({
      name: "already live",
      body: "Should fail",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 18,
      audience: {
        search: "oak",
        blockStack: [{ id: "new-vacancy", kind: "vacancy", tri: "yes" }],
      },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "DUPLICATE_NAME",
        message: 'A campaign named "already live" already exists.',
      },
    });
  });

  it("archives and restores a campaign back to the correct status", async () => {
    const email = uniqueCampaignEmail("campaign-archive");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const created = await createCampaign({
      name: "Archive Me",
      body: "Body",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 18,
      skipIfContacted: false,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-archive", kind: "vacancy", tri: "yes" }],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const archived = await archiveCampaign(created.data.id);
    expect(archived.ok).toBe(true);

    let { data: row } = await testClient
      .from("campaigns")
      .select("status, archived_at")
      .eq("id", created.data.id)
      .single();
    expect(row?.status).toBe("archived");
    expect(row?.archived_at).toBeTruthy();

    const restored = await unarchiveCampaign(created.data.id);
    expect(restored.ok).toBe(true);

    ({ data: row } = await testClient
      .from("campaigns")
      .select("status, archived_at")
      .eq("id", created.data.id)
      .single());
    expect(row?.status).toBe("active");
    expect(row?.archived_at).toBeNull();
  });

  it("rejects create with SENDER_NOT_APPROVED when the sender is not in the synced catalog", async () => {
    const email = uniqueCampaignEmail("campaign-unknown-sender");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const result = await createCampaign({
      name: "Unknown Sender Campaign",
      body: "Should never save",
      senderNumber: "+15550001111",
      paceSeconds: 18,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-sender", kind: "vacancy", tri: "yes" }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SENDER_NOT_APPROVED");

    const { count } = await testClient
      .from("campaigns")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });

  it("rejects create with PROVIDER_CAMPAIGN_NOT_FOUND for a provider campaign missing from the catalog", async () => {
    const email = uniqueCampaignEmail("campaign-bad-provider-campaign");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const result = await createCampaign({
      name: "Bad Provider Campaign",
      body: "Should never save",
      senderNumber: MOCK_SENDER_PRIMARY,
      providerCampaignExternalId: "not-a-synced-provider-campaign",
      paceSeconds: 18,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-pc", kind: "vacancy", tri: "yes" }],
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PROVIDER_CAMPAIGN_NOT_FOUND");
  });

  it("locks the sender on a revived campaign that already queued messages (SENDER_LOCKED)", async () => {
    const orgId = await getOrgId();
    const email = uniqueCampaignEmail("campaign-sender-locked");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const created = await createCampaign({
      name: "Locked Sender Revive",
      body: "First body",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 18,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-lock", kind: "vacancy", tri: "yes" }],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The campaign has outbound rows → the stored sender is immutable.
    const { error: msgError } = await testClient.from("messages").insert({
      org_id: orgId,
      channel: "sms",
      direction: "outbound",
      status: "sent",
      campaign_id: created.data.id,
      from_address: MOCK_SENDER_PRIMARY,
      to_address: "+18165550777",
      body: "locked sender outbound",
    });
    expect(msgError).toBeNull();

    const archived = await archiveCampaign(created.data.id);
    expect(archived.ok).toBe(true);

    const revived = await createCampaign({
      name: "locked sender revive",
      body: "Second body",
      senderNumber: MOCK_SENDER_SECONDARY,
      paceSeconds: 18,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-lock-2", kind: "vacancy", tri: "yes" }],
      },
    });

    expect(revived.ok).toBe(false);
    if (revived.ok) return;
    expect(revived.error.code).toBe("SENDER_LOCKED");
    expect(revived.error.message).toContain(MOCK_SENDER_PRIMARY);

    // The archived campaign stays archived with its original sender.
    const { data: row } = await testClient
      .from("campaigns")
      .select("status, sender_number")
      .eq("id", created.data.id)
      .single();
    expect(row).toMatchObject({
      status: "archived",
      sender_number: MOCK_SENDER_PRIMARY,
    });
  });

  it("restamps the sender when reviving an archived campaign with no outbound messages", async () => {
    const email = uniqueCampaignEmail("campaign-sender-restamp");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const created = await createCampaign({
      name: "Unlocked Sender Revive",
      body: "First body",
      senderNumber: MOCK_SENDER_PRIMARY,
      paceSeconds: 18,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-restamp", kind: "vacancy", tri: "yes" }],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const archived = await archiveCampaign(created.data.id);
    expect(archived.ok).toBe(true);

    const revived = await createCampaign({
      name: "unlocked sender revive",
      body: "Second body",
      senderNumber: MOCK_SENDER_SECONDARY,
      paceSeconds: 18,
      audience: {
        search: null,
        blockStack: [{ id: "vacancy-restamp-2", kind: "vacancy", tri: "yes" }],
      },
    });
    expect(revived.ok).toBe(true);
    if (!revived.ok) return;
    expect(revived.data.id).toBe(created.data.id);

    const { data: row } = await testClient
      .from("campaigns")
      .select("status, sender_provider, sender_number")
      .eq("id", created.data.id)
      .single();
    expect(row).toMatchObject({
      status: "active",
      sender_provider: "mock",
      sender_number: MOCK_SENDER_SECONDARY,
    });
  });

  it("rejects archiving a launching campaign without flipping it to archived", async () => {
    const orgId = await getOrgId();
    const campaignId = await seedCampaign({
      orgId,
      name: "Launching Now",
      audienceSnapshot: {
        search: null,
        blockStack: [{ id: "launching-vacancy", kind: "vacancy", tri: "yes" }],
      },
      body: "Still launching",
      status: "launching",
    });

    const result = await archiveCampaign(campaignId);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "CAMPAIGN_STATE_CONFLICT",
        message: "Wait for the launch to finish before archiving this campaign.",
      },
    });

    const { data: row } = await testClient
      .from("campaigns")
      .select("status, archived_at")
      .eq("id", campaignId)
      .single();
    expect(row).toMatchObject({
      status: "launching",
      archived_at: null,
    });
  });
});

describe("launchCampaign (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    resetMockState();
    currentUserId = null;
    currentEmail = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SAFE_NOW);
    // Campaign launches queue from the campaign's stored sender; the
    // sender must exist in the synced catalog for the release guard.
    await seedSenderCatalog(testClient, await getOrgId(), [
      MOCK_SENDER_PRIMARY,
      MOCK_SENDER_SECONDARY,
    ]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const id of createdAuthUsers) {
      await testClient.auth.admin.deleteUser(id);
    }
    createdAuthUsers.length = 0;
  });

  it("freezes a deduped recipient set, stamps queued blast rows, and is idempotent on relaunch", async () => {
    const orgId = await getOrgId();
    const launchEmail = uniqueCampaignEmail("campaign-launch");
    const userId = await createAuthUser(launchEmail);
    currentUserId = userId;
    currentEmail = launchEmail;

    const tagId = await seedTag(orgId, "Campaign Launch");
    const first = await seedTaggedLead({
      orgId,
      tagId,
      address: "1 Campaign Way",
      phone: "+18165551001",
    });
    const second = await seedTaggedLead({
      orgId,
      tagId,
      address: "2 Campaign Way",
      phone: "+18165551002",
    });
    const later = await seedTaggedLead({
      orgId,
      address: "3 Later Drift Ave",
      phone: "+18165551003",
    });

    const campaignId = await seedCampaign({
      orgId,
      audienceSnapshot: {
        search: null,
        blockStack: [
          {
            id: "tag-launch",
            kind: "tag",
            combinator: "any",
            values: [tagId],
          },
        ],
      },
      body: "Campaign hello",
    });

    const firstLaunch = await launchCampaign(campaignId);
    expect(firstLaunch.ok).toBe(true);
    if (!firstLaunch.ok) return;
    expect(firstLaunch.data.alreadyLaunched).toBe(false);
    expect(firstLaunch.data.recipientCount).toBe(2);
    expect(firstLaunch.data.succeeded).toBe(2);
    expect(firstLaunch.data.skipped).toBe(0);

    const { data: recipients } = await testClient
      .from("campaign_recipients")
      .select("property_id, contact_id")
      .eq("campaign_id", campaignId)
      .order("property_id", { ascending: true });
    expect(recipients).toHaveLength(2);
    expect(new Set(recipients!.map((row) => row.property_id)).size).toBe(2);
    expect(
      new Set(recipients!.map((row) => row.contact_id).filter(Boolean)).size,
    ).toBe(2);

    const { data: queuedRows } = await testClient
      .from("messages")
      .select(
        "property_id, contact_id, campaign_id, status, body, scheduled_for, from_address",
      )
      .eq("campaign_id", campaignId)
      .order("scheduled_for", { ascending: true });
    expect(queuedRows).toHaveLength(2);
    expect(sortIds(queuedRows?.map((row) => row.property_id))).toEqual(
      sortIds([first.propertyId, second.propertyId]),
    );
    expect(queuedRows?.every((row) => row.body === "Campaign hello")).toBe(true);
    expect(queuedRows?.every((row) => row.status === "queued")).toBe(true);
    // Every queued row sends from the campaign's stored Delivery sender.
    expect(
      queuedRows?.every((row) => row.from_address === MOCK_SENDER_PRIMARY),
    ).toBe(true);
    expect(queuedRows?.every((row) => row.campaign_id === campaignId)).toBe(true);
    expect(new Date(queuedRows![0].scheduled_for!).getTime()).toBe(
      SAFE_NOW.getTime(),
    );
    expect(new Date(queuedRows![1].scheduled_for!).getTime()).toBe(
      SAFE_NOW.getTime() + 8_000,
    );

    const { data: campaignAfterLaunch } = await testClient
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .single();
    expect(campaignAfterLaunch?.status).toBe("completed");

    const { error: retagError } = await testClient.from("property_tags").insert({
      property_id: later.propertyId,
      tag_id: tagId,
    });
    expect(retagError).toBeNull();

    const secondLaunch = await launchCampaign(campaignId);
    expect(secondLaunch.ok).toBe(true);
    if (!secondLaunch.ok) return;
    expect(secondLaunch.data.alreadyLaunched).toBe(true);
    expect(secondLaunch.data.recipientCount).toBe(2);
    expect(secondLaunch.data.succeeded).toBe(0);

    const { count: recipientsAfterRelaunch } = await testClient
      .from("campaign_recipients")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    expect(recipientsAfterRelaunch).toBe(2);

    const { count: messagesAfterRelaunch } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    expect(messagesAfterRelaunch).toBe(2);
  });

  it("rejects launch with CAMPAIGN_SENDER_REQUIRED when the campaign has no stored sender", async () => {
    const orgId = await getOrgId();
    const email = uniqueCampaignEmail("campaign-launch-no-sender");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const tagId = await seedTag(orgId, "No Sender Launch");
    await seedTaggedLead({
      orgId,
      tagId,
      address: "1 No Sender Way",
      phone: "+18165551041",
    });

    const campaignId = await seedCampaign({
      orgId,
      audienceSnapshot: {
        search: null,
        blockStack: [
          {
            id: "tag-no-sender",
            kind: "tag",
            combinator: "any",
            values: [tagId],
          },
        ],
      },
      body: "Should never queue",
      senderNumber: null,
    });

    const launch = await launchCampaign(campaignId);
    expect(launch.ok).toBe(false);
    if (launch.ok) return;
    expect(launch.error.code).toBe("CAMPAIGN_SENDER_REQUIRED");

    const { count: messageCount } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    expect(messageCount).toBe(0);

    const { data: campaignRow } = await testClient
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .single();
    expect(campaignRow?.status).toBe("active");
  });

  it("rejects a concurrent second launch and keeps one outbound message per property", async () => {
    const orgId = await getOrgId();
    const raceEmail = uniqueCampaignEmail("campaign-race");
    const userId = await createAuthUser(raceEmail);
    currentUserId = userId;
    currentEmail = raceEmail;

    const tagId = await seedTag(orgId, "Campaign Race");
    const first = await seedTaggedLead({
      orgId,
      tagId,
      address: "1 Race Condition Rd",
      phone: "+18165551011",
    });
    const second = await seedTaggedLead({
      orgId,
      tagId,
      address: "2 Race Condition Rd",
      phone: "+18165551012",
    });

    const campaignId = await seedCampaign({
      orgId,
      audienceSnapshot: {
        search: null,
        blockStack: [
          {
            id: "tag-race",
            kind: "tag",
            combinator: "any",
            values: [tagId],
          },
        ],
      },
      body: "Race-safe hello",
    });

    const launches = await Promise.all([
      launchCampaign(campaignId),
      launchCampaign(campaignId),
    ]);

    expect(launches.every((result) => result.ok)).toBe(true);
    const successfulLaunches = launches.filter(
      (result): result is Extract<(typeof launches)[number], { ok: true }> =>
        result.ok,
    );
    expect(
      successfulLaunches.filter((result) => result.data.alreadyLaunched === false),
    ).toHaveLength(1);
    expect(
      successfulLaunches.filter((result) => result.data.alreadyLaunched === true),
    ).toHaveLength(1);

    const { data: recipients } = await testClient
      .from("campaign_recipients")
      .select("property_id")
      .eq("campaign_id", campaignId)
      .order("property_id", { ascending: true });
    expect(sortIds(recipients?.map((row) => row.property_id))).toEqual(
      sortIds([first.propertyId, second.propertyId]),
    );

    const { data: queuedRows } = await testClient
      .from("messages")
      .select("property_id, campaign_id")
      .eq("campaign_id", campaignId)
      .order("property_id", { ascending: true });
    expect(sortIds(queuedRows?.map((row) => row.property_id))).toEqual(
      sortIds([first.propertyId, second.propertyId]),
    );
    expect(queuedRows?.every((row) => row.campaign_id === campaignId)).toBe(true);
  });

  it("allows relaunch when a launching campaign has zero stamped messages", async () => {
    const orgId = await getOrgId();
    const recoveryEmail = uniqueCampaignEmail("campaign-recovery");
    const userId = await createAuthUser(recoveryEmail);
    currentUserId = userId;
    currentEmail = recoveryEmail;

    const tagId = await seedTag(orgId, "Campaign Recovery");
    const lead = await seedTaggedLead({
      orgId,
      tagId,
      address: "1 Recovery Way",
      phone: "+18165551021",
    });

    const campaignId = await seedCampaign({
      orgId,
      audienceSnapshot: {
        search: null,
        blockStack: [
          {
            id: "tag-recovery",
            kind: "tag",
            combinator: "any",
            values: [tagId],
          },
        ],
      },
      body: "Recovered launch",
      status: "launching",
    });

    const launch = await launchCampaign(campaignId);
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.data.alreadyLaunched).toBe(false);
    expect(launch.data.recipientCount).toBe(1);

    const { data: campaignRow } = await testClient
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .single();
    expect(campaignRow?.status).toBe("completed");

    const { data: messages } = await testClient
      .from("messages")
      .select("property_id")
      .eq("campaign_id", campaignId);
    expect(messages?.map((row) => row.property_id)).toEqual([lead.propertyId]);
  });

  it("rejects launch when the saved audience only contains no-op filters", async () => {
    const orgId = await getOrgId();
    const email = uniqueCampaignEmail("campaign-launch-empty-audience");
    const userId = await createAuthUser(email);
    currentUserId = userId;
    currentEmail = email;

    const campaignId = await seedCampaign({
      orgId,
      audienceSnapshot: {
        search: null,
        blockStack: [
          { id: "vacancy-empty", kind: "vacancy", tri: "any" },
          {
            id: "state-empty",
            kind: "state",
            combinator: "any",
            values: [],
          },
        ],
      },
      body: "Should never send",
    });

    const launch = await launchCampaign(campaignId);
    expect(launch).toEqual({
      ok: false,
      error: {
        code: "VALIDATION",
        message: EMPTY_AUDIENCE_VALIDATION_MESSAGE,
      },
    });

    const { count: recipientCount } = await testClient
      .from("campaign_recipients")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    expect(recipientCount).toBe(0);

    const { count: messageCount } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    expect(messageCount).toBe(0);

    const { data: campaignRow } = await testClient
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .single();
    expect(campaignRow?.status).toBe("active");
  });

  it.skip("serializes campaignId through the deferred workflow path, keeps the campaign launching until finalize, and stamps every chunked row", async () => {
    // Requires the Vercel Workflow runtime, which Vitest does not host.
    // The non-deferred launch tests still cover campaign stamping and launch-state behavior.
    const orgId = await getOrgId();
    const workflowEmail = uniqueCampaignEmail("campaign-workflow");
    const userId = await createAuthUser(workflowEmail);
    currentUserId = userId;
    currentEmail = workflowEmail;

    const tagId = await seedTag(orgId, "Workflow Campaign");
    const propertyIds: string[] = [];
    for (let i = 0; i < 501; i++) {
      const lead = await seedTaggedLead({
        orgId,
        tagId,
        address: `${i} Workflow St`,
        phone: `+1816${(7000000 + i).toString().padStart(7, "0")}`,
      });
      propertyIds.push(lead.propertyId);
    }

    const campaignId = await seedCampaign({
      orgId,
      audienceSnapshot: {
        search: null,
        blockStack: [
          {
            id: "tag-workflow",
            kind: "tag",
            combinator: "any",
            values: [tagId],
          },
        ],
      },
      body: "Workflow blast",
    });

    const launch = await launchCampaign(campaignId);
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.data.alreadyLaunched).toBe(false);
    expect(launch.data.recipientCount).toBe(501);
    expect(launch.data.deferred?.total).toBe(501);
    expect(launch.data.deferred?.jobId).toBeTruthy();

    const { data: campaignBeforeWorkflow } = await testClient
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .single();
    expect(campaignBeforeWorkflow?.status).toBe("launching");

    const { count: messageCountBeforeWorkflow } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    expect(messageCountBeforeWorkflow).toBe(0);

    const jobId = launch.data.deferred!.jobId;
    const { data: jobRow } = await testClient
      .from("jobs")
      .select("input_params")
      .eq("id", jobId)
      .single();
    const opts = (jobRow?.input_params as { opts?: { campaignId?: string | null } })
      .opts;
    expect(opts?.campaignId).toBe(campaignId);

    const workflowResult = await bulkSmsWorkflow({ jobId });
    expect(workflowResult).toEqual({ queued: 501, skipped: 0, failed: 0 });

    const { count: campaignMessageCount } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    expect(campaignMessageCount).toBe(501);

    const { count: unstampedQueuedCount } = await testClient
      .from("messages")
      .select("*", { count: "exact", head: true })
      .is("campaign_id", null)
      .eq("status", "queued");
    expect(unstampedQueuedCount).toBe(0);

    const { data: sampleRows } = await testClient
      .from("messages")
      .select("campaign_id, status")
      .eq("campaign_id", campaignId)
      .limit(5);
    expect(sampleRows?.every((row) => row.campaign_id === campaignId)).toBe(true);
    expect(sampleRows?.every((row) => row.status === "queued")).toBe(true);

    const { data: campaignAfterWorkflow } = await testClient
      .from("campaigns")
      .select("status")
      .eq("id", campaignId)
      .single();
    expect(campaignAfterWorkflow?.status).toBe("completed");
  });
});
