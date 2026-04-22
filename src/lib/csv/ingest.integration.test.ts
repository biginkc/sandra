import { beforeEach, describe, expect, it } from "vitest";

import { runIngestion } from "@/lib/csv/ingest";
import type { Mapping, RowData } from "@/lib/csv/validate";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();

/**
 * End-to-end coverage of the CSV ingestion pipeline against a real Postgres.
 * Focus: the layered dedup cascade, contact upsert behavior, per-row
 * job_items outcomes, and terminal job status. Provider calls are
 * abstracted — the DealMachine / Zillow / etc. source field is just a
 * string tag here.
 */

async function createImportJob(
  source = "dealmachine",
  market = "Kansas City",
  totalRows = 0,
): Promise<{ jobId: string; csvImportId: string }> {
  const { data: importRow, error: importErr } = await supabase
    .from("csv_imports")
    .insert({ source, market, total_rows: totalRows, filename: "integration-test.csv" })
    .select("id")
    .single();
  if (importErr || !importRow) throw importErr ?? new Error("import insert failed");

  const { data: jobRow, error: jobErr } = await supabase
    .from("jobs")
    .insert({
      type: "csv_import",
      status: "queued",
      total_items: totalRows,
      related_import_id: importRow.id,
      title: "Integration test import",
    })
    .select("id")
    .single();
  if (jobErr || !jobRow) throw jobErr ?? new Error("job insert failed");

  return { jobId: jobRow.id, csvImportId: importRow.id };
}

describe("runIngestion (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("inserts valid rows end-to-end, writes job_items, marks job completed", async () => {
    const { jobId, csvImportId } = await createImportJob(
      "dealmachine",
      "Kansas City",
      3,
    );

    const mapping: Mapping = {
      address: "Address",
      city: "City",
      state: "State",
      zip: "Zip",
      homeowner_first_name: "First",
      homeowner_last_name: "Last",
      homeowner_phone_1: "Phone",
    };
    const rows: RowData[] = [
      {
        Address: "1 A St",
        City: "KC",
        State: "MO",
        Zip: "64108",
        First: "Alex",
        Last: "Abbot",
        Phone: "8165550001",
      },
      {
        Address: "2 B Ave",
        City: "KC",
        State: "MO",
        Zip: "64108",
        First: "Blair",
        Last: "Boone",
        Phone: "8165550002",
      },
      {
        Address: "3 C Blvd",
        City: "KC",
        State: "MO",
        Zip: "64108",
        First: "Casey",
        Last: "Cole",
        Phone: "8165550003",
      },
    ];

    const summary = await runIngestion(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows,
    });

    expect(summary).toMatchObject({ succeeded: 3, failed: 0, skipped: 0 });

    const { count: propCount } = await supabase
      .from("properties")
      .select("*", { count: "exact", head: true });
    expect(propCount).toBe(3);

    const { count: contactCount } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true });
    expect(contactCount).toBe(3);

    const { data: itemStatuses } = await supabase
      .from("job_items")
      .select("status")
      .eq("job_id", jobId);
    expect(itemStatuses?.every((r) => r.status === "success")).toBe(true);

    const { data: job } = await supabase
      .from("jobs")
      .select("status, succeeded_items, failed_items")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("completed");
    expect(job?.succeeded_items).toBe(3);
    expect(job?.failed_items).toBe(0);
  });

  it("collapses address variants via the dedup cascade (skipped=1)", async () => {
    const { jobId, csvImportId } = await createImportJob("dealmachine", "Kansas City", 2);

    const mapping: Mapping = {
      address: "Address",
      state: "State",
    };
    const rows: RowData[] = [
      { Address: "100 Main St", State: "MO" },
      // Casing + suffix variant of the same address — should collapse.
      { Address: "100 MAIN STREET", State: "MO" },
    ];

    const summary = await runIngestion(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows,
    });

    expect(summary.succeeded).toBe(1);
    expect(summary.skipped).toBe(1);

    const { count } = await supabase
      .from("properties")
      .select("*", { count: "exact", head: true });
    expect(count).toBe(1);
  });

  it("upserts repeated homeowners by phone — two rows, same phone → one contact", async () => {
    const { jobId, csvImportId } = await createImportJob("dealmachine", "Kansas City", 2);

    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_phone_1: "Phone",
    };
    const rows: RowData[] = [
      { Address: "10 Oak Ln", State: "MO", Phone: "8165559999" },
      { Address: "11 Pine Rd", State: "MO", Phone: "8165559999" },
    ];

    const summary = await runIngestion(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows,
    });
    expect(summary.succeeded).toBe(2);

    const { count: propCount } = await supabase
      .from("properties")
      .select("*", { count: "exact", head: true });
    expect(propCount).toBe(2);

    const { count: contactCount } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true });
    expect(contactCount).toBe(1);
  });

  it("records invalid rows as job_items errors and marks job partial", async () => {
    const { jobId, csvImportId } = await createImportJob("dealmachine", "Kansas City", 2);

    const mapping: Mapping = { address: "Address", state: "State" };
    const rows: RowData[] = [
      { Address: "20 Ash St", State: "MO" }, // valid
      { Address: "21 Birch Ave", State: "" }, // missing required state
    ];

    const summary = await runIngestion(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows,
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);

    const { data: job } = await supabase
      .from("jobs")
      .select("status, succeeded_items, failed_items")
      .eq("id", jobId)
      .single();
    expect(job?.status).toBe("partial");
    expect(job?.succeeded_items).toBe(1);
    expect(job?.failed_items).toBe(1);

    const { data: errorItems } = await supabase
      .from("job_items")
      .select("status, error_class")
      .eq("job_id", jobId)
      .eq("status", "error");
    expect(errorItems).toHaveLength(1);
    expect(errorItems?.[0].error_class).toBe("validation");
  });

  it("silently skips fully-blank rows (no failure, no insert)", async () => {
    const { jobId, csvImportId } = await createImportJob("dealmachine", "Kansas City", 2);

    const mapping: Mapping = { address: "Address", state: "State" };
    const rows: RowData[] = [
      { Address: "30 Maple Ct", State: "MO" },
      { Address: "", State: "" }, // blank — skipped, not failed
    ];

    const summary = await runIngestion(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows,
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("parses DealMachine Skipped shape (address_full → components)", async () => {
    const { jobId, csvImportId } = await createImportJob("dealmachine", "Kansas City", 1);

    const mapping: Mapping = { address_full: "Combined" };
    const rows: RowData[] = [
      { Combined: "742 Evergreen Ter, Springfield, MO 65801" },
    ];

    const summary = await runIngestion(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows,
    });
    expect(summary.succeeded).toBe(1);

    const { data: prop } = await supabase
      .from("properties")
      .select("address, city, state, zip")
      .limit(1)
      .single();
    expect(prop?.address).toBe("742 Evergreen Ter");
    expect(prop?.city).toBe("Springfield");
    expect(prop?.state).toBe("MO");
    expect(prop?.zip).toBe("65801");
  });
});
