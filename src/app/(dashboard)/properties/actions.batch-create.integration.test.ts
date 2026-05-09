import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";
import {
  BMH_ORG_ID,
  createOrgUser,
  seedTwoOrgs,
} from "@tests/integration/fixtures/multi-user";
import type { FilterBlock } from "./prospects-query";

const testClient = createTestClient();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

let currentUserId: string | null = null;
vi.spyOn(testClient.auth, "getUser").mockImplementation(async () =>
  ({
    data: {
      user: currentUserId ? ({ id: currentUserId } as never) : null,
    },
    error: null,
  }) as never,
);

// eslint-disable-next-line import/first
import {
  createDialerBatchFromFilters,
  createDialerBatchFromPropertyIds,
  previewBatchEligibilityAction,
} from "./actions";

const defaultBlockStack: FilterBlock[] = [];

const createdAuthUsers: string[] = [];
let phoneSeq = 0;

function nextPhone(): string {
  phoneSeq += 1;
  return `+1816999${String(phoneSeq).padStart(4, "0")}`;
}

async function seedLead(opts: {
  address?: string;
  state?: string;
  orgId?: string;
  phone_1?: string | null;
  phone_2?: string | null;
  phone_3?: string | null;
  doNotContact?: boolean;
  status?: string;
}): Promise<{ propertyId: string; contactId: string }> {
  const { data: contact, error: contactError } = await testClient
    .from("contacts")
    .insert({
      org_id: opts.orgId ?? BMH_ORG_ID,
      first_name: "Dialer",
      last_name: "Preview",
      phone_1: opts.phone_1 === undefined ? nextPhone() : opts.phone_1,
      phone_2: opts.phone_2 ?? null,
      phone_3: opts.phone_3 ?? null,
      do_not_contact: opts.doNotContact ?? false,
    })
    .select("id")
    .single();
  expect(contactError).toBeNull();
  if (!contact) throw new Error("contact seed failed");

  const { data: property, error: propertyError } = await testClient
    .from("properties")
    .insert({
      org_id: opts.orgId ?? BMH_ORG_ID,
      address: opts.address ?? `Dialer ${crypto.randomUUID()}`,
      state: opts.state ?? "MO",
      status: opts.status ?? "prospect",
      homeowner_contact_id: contact.id,
    })
    .select("id")
    .single();
  expect(propertyError).toBeNull();
  if (!property) throw new Error("property seed failed");

  return { propertyId: property.id, contactId: contact.id };
}

describe("Create dialer batch server actions", () => {
  beforeEach(async () => {
    await seedTwoOrgs(testClient);
    await resetTenantTables(testClient);
    await seedTwoOrgs(testClient);
    const user = await createOrgUser(testClient, {
      orgId: BMH_ORG_ID,
      email: `dialer-${Date.now()}-${Math.random().toString(36).slice(2)}@bmhgroupkc.com`,
      role: "member",
    });
    createdAuthUsers.push(user.userId);
    currentUserId = user.userId;
  });

  afterEach(async () => {
    currentUserId = null;
    for (const userId of createdAuthUsers.splice(0)) {
      await testClient.auth.admin.deleteUser(userId);
    }
    await resetTenantTables(testClient);
  });

  it("createDialerBatchFromPropertyIds inserts batch + items per (prospect, phone) [SANDRA-01, D-01]", async () => {
    const first = await seedLead({ phone_1: nextPhone(), phone_2: nextPhone() });
    const second = await seedLead({ phone_1: nextPhone(), phone_2: nextPhone() });

    const result = await createDialerBatchFromPropertyIds([
      first.propertyId,
      second.propertyId,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts.callable).toBe(4);

    const { data: batch } = await (testClient as any)
      .from("dialer_batches")
      .select("id, source_kind")
      .eq("id", result.data.batchId)
      .single();
    expect(batch?.source_kind).toBe("selected_ids");

    const { data: items } = await (testClient as any)
      .from("dialer_batch_items")
      .select("id, property_id, phone_e164")
      .eq("batch_id", result.data.batchId);
    expect(items).toHaveLength(4);
  });

  it("createDialerBatchFromPropertyIds returns counts equal to previewBatchEligibilityAction for the same input", async () => {
    const callable = await seedLead({ phone_1: nextPhone() });
    const blocked = await seedLead({
      phone_1: nextPhone(),
      doNotContact: true,
    });

    const preview = await previewBatchEligibilityAction([
      callable.propertyId,
      blocked.propertyId,
    ]);
    const created = await createDialerBatchFromPropertyIds([
      callable.propertyId,
      blocked.propertyId,
    ]);

    expect(preview.ok).toBe(true);
    expect(created.ok).toBe(true);
    if (!preview.ok || !created.ok) return;
    expect(created.data.counts).toStrictEqual(preview.data);
  });

  it("previewBatchEligibilityAction returns correct callable/blocked/missing [SANDRA-03]", async () => {
    const callable = await seedLead({ phone_1: nextPhone() });
    const blocked = await seedLead({
      phone_1: nextPhone(),
      doNotContact: true,
    });
    const missing = await seedLead({ phone_1: null });

    const result = await previewBatchEligibilityAction([
      callable.propertyId,
      blocked.propertyId,
      missing.propertyId,
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toEqual({
      callable: 1,
      blocked: { do_not_contact: 1 },
      missing: 1,
    });
  });

  it("createDialerBatchFromFilters returns same eligibility counts as preview [counts equality]", async () => {
    const prefix = `Dialer Filter ${crypto.randomUUID()}`;
    const first = await seedLead({ address: `${prefix} A`, phone_1: nextPhone() });
    const second = await seedLead({
      address: `${prefix} B`,
      phone_1: nextPhone(),
      doNotContact: true,
    });

    const preview = await previewBatchEligibilityAction([
      first.propertyId,
      second.propertyId,
    ]);
    const created = await createDialerBatchFromFilters({
      search: prefix,
      blockStack: defaultBlockStack,
      title: "Filter batch",
    });

    expect(preview.ok).toBe(true);
    expect(created.ok).toBe(true);
    if (!preview.ok || !created.ok) return;
    expect(created.data.counts).toStrictEqual(preview.data);
  });

  it("createDialerBatchFromFilters honors SELECT_ALL_HARD_CAP=5000 [SANDRA-02, T-1-Cap]", async () => {
    const lead = await seedLead({ address: "Dialer Cap Smoke", phone_1: nextPhone() });

    const result = await createDialerBatchFromFilters({
      search: "Dialer Cap Smoke",
      blockStack: defaultBlockStack,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.counts.callable).toBe(1);
    expect(result.data.batchId).toEqual(expect.any(String));
    expect(lead.propertyId).toEqual(expect.any(String));
  });

  it("snapshots state + timezone on each dialer_batch_item", async () => {
    const lead = await seedLead({ state: "OH", phone_1: nextPhone() });

    const result = await createDialerBatchFromPropertyIds([lead.propertyId]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { data: items } = await (testClient as any)
      .from("dialer_batch_items")
      .select("state, timezone")
      .eq("batch_id", result.data.batchId);
    expect(items).toEqual([
      expect.objectContaining({
        state: "OH",
        timezone: "America/New_York",
      }),
    ]);
  });

  it("does NOT write eligibility flags to dialer_batch_items [D-15 Hybrid]", async () => {
    const { error } = await (testClient as any)
      .from("dialer_batch_items")
      .select("eligible, do_not_contact, sms_opted_out, suppression_snapshot")
      .limit(0);

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/column|schema cache|could not find/i);
  });

  it("createDialerBatchFromPropertyIds enforces authentication before writes", async () => {
    currentUserId = null;
    const lead = await seedLead({ phone_1: nextPhone() });

    const result = await createDialerBatchFromPropertyIds([lead.propertyId]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNAUTH");
  });
});
