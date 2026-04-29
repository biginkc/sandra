import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const testClient = createTestClient();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => testClient,
}));

// eslint-disable-next-line import/first
import {
  archiveList,
  createList,
  unarchiveList,
} from "@/app/(dashboard)/lists/actions";
// eslint-disable-next-line import/first
import { runIngestion } from "@/lib/csv/ingest";

// The 20 system-managed lists seeded by migration 031. Tests assert the
// names round-trip exactly (no migration-time mangling) and the order
// matches the system-first, then-alphabetical sort rule.
const SYSTEM_MANAGED_LIST_NAMES = [
  "Auctions",
  "Bank Owned",
  "Bankruptcy",
  "Cash Buyers",
  "Divorce",
  "Failed Listings",
  "Flippers",
  "Free & Clear",
  "High Equity",
  "Liens",
  "On Market",
  "Pre-Foreclosures",
  "Pre-Probate",
  "Senior Owners",
  "Tax Delinquency",
  "Tired Landlords",
  "Upside Down",
  "Vacant",
  "Vacant Land",
  "Zombie Properties",
];

describe("Lists + property_lists stacking (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(testClient);
  });

  // --------------------------------------------------------------------------
  // System-managed lists (migration 031)
  // --------------------------------------------------------------------------
  describe("system-managed lists", () => {
    it("seeds all 20 PropStream-style lists after migration", async () => {
      const { data, error } = await testClient
        .from("lists")
        .select("name, system_managed, archived_at")
        .eq("system_managed", true)
        .order("name", { ascending: true });
      expect(error).toBeNull();
      const names = (data ?? []).map((r) => r.name);
      const expected = [...SYSTEM_MANAGED_LIST_NAMES].sort();
      expect(names).toEqual(expected);
      // None should ship archived.
      for (const row of data ?? []) {
        expect(row.archived_at).toBeNull();
        expect(row.system_managed).toBe(true);
      }
    });

    it("createList defaults system_managed to false on new lists", async () => {
      const result = await createList({ name: "VA-Created Cohort" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("create failed");

      const { data } = await testClient
        .from("lists")
        .select("system_managed")
        .eq("id", result.data.id)
        .single();
      expect(data?.system_managed).toBe(false);
    });

    it("archiveList rejects with SYSTEM_MANAGED_LIST on a system-managed row", async () => {
      const { data: vacant } = await testClient
        .from("lists")
        .select("id")
        .eq("name", "Vacant")
        .eq("system_managed", true)
        .single();
      expect(vacant?.id).toBeTruthy();

      const result = await archiveList(vacant!.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("SYSTEM_MANAGED_LIST");

      // Row must remain unarchived — defense-in-depth proof.
      const { data } = await testClient
        .from("lists")
        .select("archived_at")
        .eq("id", vacant!.id)
        .single();
      expect(data?.archived_at).toBeNull();
    });

    it("unarchiveList rejects with SYSTEM_MANAGED_LIST on a system-managed row", async () => {
      const { data: liens } = await testClient
        .from("lists")
        .select("id")
        .eq("name", "Liens")
        .eq("system_managed", true)
        .single();
      const result = await unarchiveList(liens!.id);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("SYSTEM_MANAGED_LIST");
    });

    it("list-fetch sort: system-managed first, then alphabetical", async () => {
      // Seed two non-system lists that bracket the system rows
      // alphabetically — "Aaa" would sort first if system_managed didn't
      // pin, "Zzz" would sort last either way. After sort, the 20 system
      // rows must appear before any non-system row.
      const aaa = await createList({ name: "Aaa Custom" });
      const zzz = await createList({ name: "Zzz Custom" });
      expect(aaa.ok && zzz.ok).toBe(true);

      const { data } = await testClient
        .from("lists")
        .select("name, system_managed")
        .is("archived_at", null)
        .order("system_managed", { ascending: false })
        .order("name", { ascending: true });

      const rows = data ?? [];
      // Find the boundary — first non-system row.
      const firstNonSystemIdx = rows.findIndex((r) => !r.system_managed);
      expect(firstNonSystemIdx).toBe(20); // exactly 20 system rows up top
      // System block is alphabetical.
      const systemBlock = rows.slice(0, 20).map((r) => r.name);
      expect(systemBlock).toEqual([...SYSTEM_MANAGED_LIST_NAMES].sort());
      // Non-system block is alphabetical.
      const nonSystemBlock = rows.slice(20).map((r) => r.name);
      expect(nonSystemBlock).toEqual(["Aaa Custom", "Zzz Custom"]);
    });
  });

  // --------------------------------------------------------------------------
  // createList
  // --------------------------------------------------------------------------
  describe("createList", () => {
    it("creates a list with a color", async () => {
      const result = await createList({
        name: "Pre-Foreclosure",
        color: "#ef4444",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("create failed");

      const { data } = await testClient
        .from("lists")
        .select("name, color, archived_at")
        .eq("id", result.data.id)
        .single();
      expect(data?.name).toBe("Pre-Foreclosure");
      expect(data?.color).toBe("#ef4444");
      expect(data?.archived_at).toBeNull();
    });

    it("rejects an empty name", async () => {
      const result = await createList({ name: "   " });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    });

    it("rejects a bad color", async () => {
      const result = await createList({ name: "X", color: "red" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    });

    it("case-insensitively rejects an existing name", async () => {
      const first = await createList({ name: "Probate" });
      expect(first.ok).toBe(true);
      const dup = await createList({ name: "PROBATE" });
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error.code).toBe("DUPLICATE_NAME");
    });

    it("revives an archived list when create re-uses its name", async () => {
      const first = await createList({ name: "Tired Landlord" });
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error("create failed");
      const firstId = first.data.id;

      await archiveList(firstId);

      // Creating with the same name should revive, not error.
      const revived = await createList({ name: "Tired Landlord" });
      expect(revived.ok).toBe(true);
      if (!revived.ok) throw new Error("revive failed");
      expect(revived.data.id).toBe(firstId);

      const { data } = await testClient
        .from("lists")
        .select("archived_at")
        .eq("id", firstId)
        .single();
      expect(data?.archived_at).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // archive / unarchive
  // --------------------------------------------------------------------------
  describe("archive / unarchive", () => {
    it("sets and clears archived_at", async () => {
      const create = await createList({ name: "Absentee Low Equity" });
      if (!create.ok) throw new Error("create failed");
      const id = create.data.id;

      await archiveList(id);
      let { data } = await testClient
        .from("lists")
        .select("archived_at")
        .eq("id", id)
        .single();
      expect(data?.archived_at).not.toBeNull();

      await unarchiveList(id);
      ({ data } = await testClient
        .from("lists")
        .select("archived_at")
        .eq("id", id)
        .single());
      expect(data?.archived_at).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Stacking: CSV ingest writes property_lists on both insert and dedup.
  //
  // We exercise runIngestion() directly with minimal rows so we're testing
  // the membership-writing behavior, not the wizard plumbing.
  // --------------------------------------------------------------------------
  describe("CSV ingest writes property_lists", () => {
    async function seedImportAndJob(): Promise<{
      importId: string;
      jobId: string;
    }> {
      const { data: imp } = await testClient
        .from("csv_imports")
        .insert({ filename: "test.csv", source: "generic", market: "Kansas City" })
        .select("id")
        .single();
      const { data: job } = await testClient
        .from("jobs")
        .insert({
          type: "csv_import",
          status: "queued",
          related_import_id: imp!.id,
        })
        .select("id")
        .single();
      return { importId: imp!.id, jobId: job!.id };
    }

    const baseMapping = { address: "address", state: "state", city: "city" };
    const row = { address: "123 Stack Ln", state: "MO", city: "Kansas City" };

    it("adds a property_lists row on the initial import", async () => {
      const list = await createList({ name: "Probate" });
      if (!list.ok) throw new Error("create failed");
      const { importId, jobId } = await seedImportAndJob();

      await runIngestion(testClient, {
        jobId,
        csvImportId: importId,
        source: "generic",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
        listId: list.data.id,
        userId: null,
      });

      const { data: memberships } = await testClient
        .from("property_lists")
        .select("property_id, list_id");
      expect(memberships).toHaveLength(1);
      expect(memberships![0]!.list_id).toBe(list.data.id);
    });

    it("stacks on re-import of same address into a different list", async () => {
      const listA = await createList({ name: "Absentee" });
      const listB = await createList({ name: "Tired Landlord" });
      if (!listA.ok || !listB.ok) throw new Error("create failed");

      // First import into list A.
      const a = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId: a.jobId,
        csvImportId: a.importId,
        source: "generic",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
        listId: listA.data.id,
      });

      // Second import of same row into list B.
      const b = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId: b.jobId,
        csvImportId: b.importId,
        source: "generic",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
        listId: listB.data.id,
      });

      // Should still be one property, but two memberships.
      const { data: props } = await testClient.from("properties").select("id");
      expect(props).toHaveLength(1);

      const { data: memberships } = await testClient
        .from("property_lists")
        .select("list_id");
      expect(memberships).toHaveLength(2);
      const listIds = new Set((memberships ?? []).map((m) => m.list_id));
      expect(listIds.has(listA.data.id)).toBe(true);
      expect(listIds.has(listB.data.id)).toBe(true);
    });

    it("bumps last_added_at (not first_added_at) when re-imported into the SAME list", async () => {
      const list = await createList({ name: "Pre-Foreclosure" });
      if (!list.ok) throw new Error("create failed");

      // First import.
      const a = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId: a.jobId,
        csvImportId: a.importId,
        source: "generic",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
        listId: list.data.id,
      });
      const { data: firstRow } = await testClient
        .from("property_lists")
        .select("first_added_at, last_added_at")
        .single();
      const firstAddedAt = firstRow!.first_added_at;

      // Small delay so timestamps can actually move.
      await new Promise((r) => setTimeout(r, 50));

      // Re-import into same list.
      const b = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId: b.jobId,
        csvImportId: b.importId,
        source: "generic",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
        listId: list.data.id,
      });

      // Still one membership row.
      const { data: memberships } = await testClient
        .from("property_lists")
        .select("first_added_at, last_added_at");
      expect(memberships).toHaveLength(1);

      const updated = memberships![0]!;
      expect(updated.first_added_at).toBe(firstAddedAt);
      expect(new Date(updated.last_added_at).getTime()).toBeGreaterThan(
        new Date(firstAddedAt).getTime(),
      );
    });

    it("skips writing property_lists when no listId is passed", async () => {
      const { importId, jobId } = await seedImportAndJob();
      await runIngestion(testClient, {
        jobId,
        csvImportId: importId,
        source: "generic",
        market: "Kansas City",
        mapping: baseMapping,
        rows: [row],
        // No listId — optional import.
      });
      const { data: memberships } = await testClient
        .from("property_lists")
        .select("id");
      expect(memberships).toHaveLength(0);
    });
  });
});
