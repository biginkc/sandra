import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

// eslint-disable-next-line import/first
import {
  applyPropertyTag,
  createCustomTag,
  removePropertyTag,
} from "@/app/(dashboard)/leads/tags-actions";
// eslint-disable-next-line import/first
import { runIngestion } from "@/lib/csv/ingest";

describe("Tags + ingest auto-apply (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
  });

  async function seedProperty(): Promise<string> {
    const { data, error } = await testClient
      .from("properties")
      .insert({ address: "1 Tag St", state: "MO", status: "new_lead" })
      .select("id")
      .single();
    if (error || !data) throw error ?? new Error("seed property failed");
    return data.id;
  }

  async function seedImportAndJob(): Promise<{
    importId: string;
    jobId: string;
  }> {
    const { data: imp } = await testClient
      .from("csv_imports")
      .insert({ filename: "test.csv", source: "dealmachine", market: "Kansas City" })
      .select("id")
      .single();
    const { data: job } = await testClient
      .from("jobs")
      .insert({ type: "csv_import", status: "queued", related_import_id: imp!.id })
      .select("id")
      .single();
    return { importId: imp!.id, jobId: job!.id };
  }

  // --------------------------------------------------------------------------
  // createCustomTag
  // --------------------------------------------------------------------------
  describe("createCustomTag", () => {
    it("creates a custom-category tag", async () => {
      const result = await createCustomTag("Competing offer", "#ef4444");
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("create failed");
      expect(result.data.category).toBe("custom");
      expect(result.data.system_managed).toBe(false);
      expect(result.data.color).toBe("#ef4444");
    });

    it("rejects empty and oversized names", async () => {
      const empty = await createCustomTag("   ");
      expect(empty.ok).toBe(false);
      const tooLong = await createCustomTag("x".repeat(61));
      expect(tooLong.ok).toBe(false);
    });

    it("rejects a bad color", async () => {
      const result = await createCustomTag("Fine name", "red");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    });

    it("returns existing tag on case-insensitive duplicate", async () => {
      const first = await createCustomTag("Attorney Involved");
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("create failed");
      const dup = await createCustomTag("ATTORNEY INVOLVED");
      expect(dup.ok).toBe(true);
      if (!dup.ok) throw new Error("dup failed");
      expect(dup.data.id).toBe(first.data.id);
    });
  });

  // --------------------------------------------------------------------------
  // apply / remove
  // --------------------------------------------------------------------------
  describe("applyPropertyTag / removePropertyTag", () => {
    it("attaches and detaches a custom tag", async () => {
      const propertyId = await seedProperty();
      const tag = await createCustomTag("Needs roof");
      if (!tag.ok) throw new Error("create failed");

      const attach = await applyPropertyTag(propertyId, tag.data.id);
      expect(attach.ok).toBe(true);

      let { data: rows } = await testClient
        .from("property_tags")
        .select("tag_id")
        .eq("property_id", propertyId);
      expect(rows).toHaveLength(1);

      const detach = await removePropertyTag(propertyId, tag.data.id);
      expect(detach.ok).toBe(true);

      ({ data: rows } = await testClient
        .from("property_tags")
        .select("tag_id")
        .eq("property_id", propertyId));
      expect(rows).toHaveLength(0);
    });

    it("is idempotent on attach", async () => {
      const propertyId = await seedProperty();
      const tag = await createCustomTag("Tenant-occupied");
      if (!tag.ok) throw new Error("create failed");

      await applyPropertyTag(propertyId, tag.data.id);
      await applyPropertyTag(propertyId, tag.data.id);

      const { data: rows } = await testClient
        .from("property_tags")
        .select("id")
        .eq("property_id", propertyId);
      expect(rows).toHaveLength(1);
    });

    it("blocks removal of a system-managed tag", async () => {
      const propertyId = await seedProperty();
      // Insert a system-managed tag directly (bypasses createCustomTag
      // which only creates custom-category tags).
      const { data: sysTag } = await testClient
        .from("tags")
        .insert({
          name: "source:propstream",
          category: "source",
          system_managed: true,
        })
        .select("id")
        .single();
      await applyPropertyTag(propertyId, sysTag!.id);

      const result = await removePropertyTag(propertyId, sysTag!.id);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("TAG_SYSTEM_MANAGED");

      // Membership should still be there.
      const { data: rows } = await testClient
        .from("property_tags")
        .select("id")
        .eq("property_id", propertyId);
      expect(rows).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // Ingest auto-apply — the core of the strict-tags-at-ingestion contract.
  // --------------------------------------------------------------------------
  describe("ingest auto-applies source + uploaded tags", () => {
    const baseMapping = { address: "address", state: "state", city: "city" };
    const row = { address: "1 AutoTag Ln", state: "MO", city: "Kansas City" };

    it("attaches source:<vendor> and uploaded:YYYY-MM on initial import", async () => {
      const { importId, jobId } = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId,
        csvImportId: importId,
        orgId: BMH_ORG_ID,
        source: "dealmachine",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
      });

      const { data: attached } = await testClient
        .from("property_tags")
        .select("source, tags!property_tags_tag_id_fkey(name, category, system_managed)");
      expect(attached).toHaveLength(2);

      const names = (attached ?? []).map(
        (a) => (a.tags as { name: string })?.name,
      );
      expect(names).toContain("source:dealmachine");
      // Month tag uses current UTC month — assert the prefix, not the exact value.
      expect(names.some((n) => n?.startsWith("uploaded:"))).toBe(true);

      // All rows are system-managed and source='import'.
      for (const a of attached ?? []) {
        expect((a.tags as { system_managed: boolean })?.system_managed).toBe(true);
        expect(a.source).toBe("import");
      }
    });

    it("does not duplicate membership on re-import", async () => {
      // First import.
      const a = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId: a.jobId,
        csvImportId: a.importId,
        orgId: BMH_ORG_ID,
        source: "dealmachine",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
      });

      // Second import of same row in the same month → same two tags; ON
      // CONFLICT DO NOTHING keeps one membership row per pair.
      const b = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId: b.jobId,
        csvImportId: b.importId,
        orgId: BMH_ORG_ID,
        source: "dealmachine",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
      });

      const { data: attached } = await testClient
        .from("property_tags")
        .select("tag_id");
      expect(attached).toHaveLength(2);
    });

    it("adds a second source tag when vendor changes between imports", async () => {
      const a = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId: a.jobId,
        csvImportId: a.importId,
        orgId: BMH_ORG_ID,
        source: "dealmachine",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
      });

      // Import same address from a different vendor.
      const { data: imp } = await testClient
        .from("csv_imports")
        .insert({ filename: "b.csv", source: "zillow", market: "Kansas City" })
        .select("id")
        .single();
      const { data: job } = await testClient
        .from("jobs")
        .insert({ type: "csv_import", status: "queued", related_import_id: imp!.id })
        .select("id")
        .single();
      await runIngestion(testClient, {
        jobId: job!.id,
        csvImportId: imp!.id,
        orgId: BMH_ORG_ID,
        source: "zillow",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
      });

      const { data: attached } = await testClient
        .from("property_tags")
        .select("tags!property_tags_tag_id_fkey(name)");
      const names = (attached ?? []).map(
        (a) => (a.tags as { name: string })?.name,
      );
      // Two sources + one uploaded month → 3 distinct memberships.
      expect(names).toContain("source:dealmachine");
      expect(names).toContain("source:zillow");
      expect(names.filter((n) => n?.startsWith("uploaded:"))).toHaveLength(1);
    });
  });
});
