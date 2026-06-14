import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetMockState } from "@/lib/messaging/providers/mock";
import { createTestClient } from "@tests/integration/client";
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
  return { ...actual, after: (_fn: () => unknown) => {} };
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

// eslint-disable-next-line import/first
import { launchCampaign } from "./actions";
// eslint-disable-next-line import/first
import { bulkSmsWorkflow } from "@/workflows/bulk-sms";

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
  name?: string;
}): Promise<string> {
  const { data, error } = await testClient
    .from("campaigns")
    .insert({
      org_id: args.orgId,
      name: args.name ?? `Campaign ${Math.random().toString(36).slice(2)}`,
      audience_snapshot: args.audienceSnapshot,
      status: "active",
    } as never)
    .select("id")
    .single();
  if (error || !data?.id) {
    throw new Error(`campaign seed failed: ${error?.message}`);
  }
  return data.id;
}

describe("launchCampaign (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
    resetMockState();
    currentUserId = null;
    currentEmail = null;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SAFE_NOW);
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
    const userId = await createAuthUser("jarrad+campaign-launch@bmhgroupkc.com");
    currentUserId = userId;
    currentEmail = "jarrad+campaign-launch@bmhgroupkc.com";

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
        launch: {
          body: "Campaign hello",
        },
      },
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
      .select("property_id, contact_id, campaign_id, status")
      .eq("campaign_id", campaignId)
      .order("property_id", { ascending: true });
    expect(queuedRows).toHaveLength(2);
    expect(queuedRows?.map((row) => row.property_id)).toEqual([
      first.propertyId,
      second.propertyId,
    ]);
    expect(queuedRows?.every((row) => row.status === "queued")).toBe(true);
    expect(queuedRows?.every((row) => row.campaign_id === campaignId)).toBe(true);

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

  it("serializes campaignId through the deferred workflow path so every chunked queued row is stamped", async () => {
    const orgId = await getOrgId();
    const userId = await createAuthUser("jarrad+campaign-workflow@bmhgroupkc.com");
    currentUserId = userId;
    currentEmail = "jarrad+campaign-workflow@bmhgroupkc.com";

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
        launch: {
          body: "Workflow blast",
        },
      },
    });

    const launch = await launchCampaign(campaignId);
    expect(launch.ok).toBe(true);
    if (!launch.ok) return;
    expect(launch.data.alreadyLaunched).toBe(false);
    expect(launch.data.recipientCount).toBe(501);
    expect(launch.data.deferred?.total).toBe(501);
    expect(launch.data.deferred?.jobId).toBeTruthy();

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
  });
});
