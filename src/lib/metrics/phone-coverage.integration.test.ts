import { beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import { capturePhoneCoverageSnapshot } from "./phone-coverage";

const supabase = createTestClient();

async function getOrgId(): Promise<string> {
  return getCanonicalTestOrgId(supabase);
}

async function seedContact(phones: {
  phone_1?: string | null;
  phone_2?: string | null;
  phone_3?: string | null;
}): Promise<string> {
  const orgId = await getOrgId();
  const { data, error } = await supabase
    .from("contacts")
    .insert({
      org_id: orgId,
      first_name: "Test",
      ...phones,
      phone_1_type: phones.phone_1 ? "mobile" : "unknown",
      phone_2_type: phones.phone_2 ? "mobile" : "unknown",
      phone_3_type: phones.phone_3 ? "mobile" : "unknown",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seedContact failed: ${error?.message}`);
  return data.id;
}

async function seedProperty(opts: {
  contactId?: string | null;
  deletedAt?: string | null;
}): Promise<string> {
  const orgId = await getOrgId();
  const { data, error } = await supabase
    .from("properties")
    .insert({
      org_id: orgId,
      address: `${Math.random().toString(36).slice(2)} Main St`,
      state: "MO",
      homeowner_contact_id: opts.contactId ?? null,
      deleted_at: opts.deletedAt ?? null,
    })
    .select("id")
    .single();
  if (error || !data)
    throw new Error(`seedProperty failed: ${error?.message}`);
  return data.id;
}

describe("capturePhoneCoverageSnapshot (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("counts property with only phone_1", async () => {
    const cId = await seedContact({ phone_1: "555-0001" });
    await seedProperty({ contactId: cId });

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(1);
  });

  it("counts property with only phone_2", async () => {
    const cId = await seedContact({ phone_2: "555-0002" });
    await seedProperty({ contactId: cId });

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(1);
  });

  it("counts property with only phone_3", async () => {
    const cId = await seedContact({ phone_3: "555-0003" });
    await seedProperty({ contactId: cId });

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(1);
  });

  it("counts property with all three phones as ONE", async () => {
    const cId = await seedContact({
      phone_1: "555-0001",
      phone_2: "555-0002",
      phone_3: "555-0003",
    });
    await seedProperty({ contactId: cId });

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(1);
  });

  it("excludes contact with all phones null", async () => {
    const cId = await seedContact({
      phone_1: null,
      phone_2: null,
      phone_3: null,
    });
    await seedProperty({ contactId: cId });

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(1);
  });

  it("excludes property with homeowner_contact_id null", async () => {
    await seedProperty({ contactId: null });

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(1);
  });

  it("excludes deleted_at properties from both counts", async () => {
    const cId = await seedContact({ phone_1: "555-0001" });
    await seedProperty({
      contactId: cId,
      deletedAt: new Date().toISOString(),
    });

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(0);
    expect(r.denominator).toBe(0);
  });

  it("denominator includes all non-deleted properties regardless of phone", async () => {
    const cId = await seedContact({ phone_1: "555-0001" });
    await seedProperty({ contactId: cId }); // has phone
    await seedProperty({ contactId: null }); // no contact

    const r = await capturePhoneCoverageSnapshot(supabase);
    expect(r.numerator).toBe(1);
    expect(r.denominator).toBe(2);
  });

  it("second same-day run upserts without creating a duplicate row", async () => {
    const cId = await seedContact({ phone_1: "555-0001" });
    await seedProperty({ contactId: cId });

    await capturePhoneCoverageSnapshot(supabase);
    await capturePhoneCoverageSnapshot(supabase);

    const { data, error } = await supabase
      .from("metric_snapshots")
      .select("id")
      .eq("metric_key", "phone_coverage");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});
