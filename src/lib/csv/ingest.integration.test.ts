import { beforeEach, describe, expect, it } from "vitest";

import {
  prepareIngestion,
  processIngestChunk,
  runIngestion,
} from "@/lib/csv/ingest";
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

  it("re-import of a qualified lead never demotes its status back to prospect", async () => {
    // Regression guard — Feature 4 part 1 made CSV ingest default to
    // `status='prospect'` on insert. Dedup MUST return the existing row
    // untouched on a second import, or a working lead (`new_lead`,
    // `contacted`, etc.) would regress every time its address appears
    // in a re-import.
    const { jobId: firstJobId, csvImportId: firstImportId } =
      await createImportJob("dealmachine", "Kansas City", 1);
    const mapping: Mapping = { address: "Address", state: "State" };
    const firstRows: RowData[] = [{ Address: "777 Regression Ave", State: "MO" }];
    const firstSummary = await runIngestion(supabase, {
      jobId: firstJobId,
      csvImportId: firstImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows: firstRows,
    });
    expect(firstSummary.succeeded).toBe(1);

    const { data: inserted } = await supabase
      .from("properties")
      .select("id, status")
      .single();
    expect(inserted?.status).toBe("prospect");

    // Qualify the prospect into the pipeline as if a VA clicked Qualify.
    await supabase
      .from("properties")
      .update({
        status: "contacted",
        qualified_at: new Date().toISOString(),
        qualified_by: "user-under-test",
      })
      .eq("id", inserted!.id);

    // Same CSV shipped from the vendor a month later — dedup should match
    // on `address_normalized` and leave the row alone.
    const { jobId: secondJobId, csvImportId: secondImportId } =
      await createImportJob("dealmachine", "Kansas City", 1);
    const secondSummary = await runIngestion(supabase, {
      jobId: secondJobId,
      csvImportId: secondImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      // A casing variant still collapses through the normalize pipeline.
      rows: [{ Address: "777 REGRESSION AVE", State: "MO" }],
    });
    expect(secondSummary.skipped).toBe(1);

    const { data: after } = await supabase
      .from("properties")
      .select("status, qualified_by")
      .eq("id", inserted!.id)
      .single();
    expect(after?.status).toBe("contacted");
    expect(after?.qualified_by).toBe("user-under-test");
  });

  it("writes cumulative succeeded/failed counts on each progress tick (live UI)", async () => {
    // Bug surfaced 2026-04-29: the wizard's Progress page showed "all
    // skipped" while the import was running because chunk progress
    // updates only wrote processed_items, leaving succeeded_items and
    // failed_items at 0 until finalizeIngestion ran. Skipped on the UI
    // is computed as `processed - succeeded - failed`, which made the
    // whole batch look skipped mid-flight.
    //
    // Fix: chunks now write cumulative succeeded/failed alongside
    // processed_items. This test simulates two sequential chunks and
    // verifies the jobs row reflects cumulative counts after each.
    const { jobId, csvImportId } = await createImportJob(
      "dealmachine",
      "Kansas City",
      // Force progress writes by exceeding PROGRESS_UPDATE_INTERVAL (10).
      24,
    );

    const mapping: Mapping = { address: "Address", state: "State" };
    const rowsChunk1: RowData[] = Array.from({ length: 12 }, (_, i) => ({
      Address: `${i + 1} First St`,
      State: "MO",
    }));
    const rowsChunk2: RowData[] = Array.from({ length: 12 }, (_, i) => ({
      Address: `${i + 1} Second St`,
      State: "MO",
    }));

    const { autoTagIds } = await prepareIngestion(supabase, {
      jobId,
      totalRows: 24,
      source: "dealmachine",
    });

    const c1 = await processIngestChunk(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows: rowsChunk1,
      offset: 0,
      autoTagIds,
      priorSucceeded: 0,
      priorFailed: 0,
    });

    // After chunk 1, jobs row should reflect chunk 1's outcome.
    const { data: afterChunk1 } = await supabase
      .from("jobs")
      .select("processed_items, succeeded_items, failed_items")
      .eq("id", jobId)
      .single();
    expect(afterChunk1?.processed_items).toBe(12);
    expect(afterChunk1?.succeeded_items).toBe(c1.succeeded);
    expect(afterChunk1?.failed_items).toBe(c1.failed);
    // The bug: succeeded_items was 0 here. Lock the contract.
    expect(afterChunk1?.succeeded_items).toBeGreaterThan(0);

    const c2 = await processIngestChunk(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows: rowsChunk2,
      offset: 12,
      autoTagIds,
      priorSucceeded: c1.succeeded,
      priorFailed: c1.failed,
    });

    // After chunk 2, cumulative across both.
    const { data: afterChunk2 } = await supabase
      .from("jobs")
      .select("processed_items, succeeded_items, failed_items")
      .eq("id", jobId)
      .single();
    expect(afterChunk2?.processed_items).toBe(24);
    expect(afterChunk2?.succeeded_items).toBe(c1.succeeded + c2.succeeded);
    expect(afterChunk2?.failed_items).toBe(c1.failed + c2.failed);
  });

  it("re-imports a soft-deleted property as a fresh row (dedup ignores deleted_at)", async () => {
    // Soft-delete = "treat as gone for ingestion purposes too." Without
    // this guard, the wipe-then-restart workflow silently dedup-matches
    // ghosts and creates zero new rows.
    const { jobId, csvImportId } = await createImportJob(
      "dealmachine",
      "Kansas City",
      1,
    );

    const mapping: Mapping = { address: "Address", state: "State" };
    const firstRow: RowData[] = [{ Address: "555 Ghost Ln", State: "MO" }];

    // First import — creates the row.
    await runIngestion(supabase, {
      jobId,
      csvImportId,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows: firstRow,
    });
    const { data: firstProperty } = await supabase
      .from("properties")
      .select("id")
      .single();
    const { count: afterFirst } = await supabase
      .from("properties")
      .select("*", { count: "exact", head: true });
    expect(afterFirst).toBe(1);

    // Soft-delete the property.
    await supabase
      .from("properties")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", firstProperty!.id);

    // Re-import the same address — should create a fresh row, not match
    // the ghost.
    const { jobId: jobId2, csvImportId: csvImportId2 } = await createImportJob(
      "dealmachine",
      "Kansas City",
      1,
    );
    const summary = await runIngestion(supabase, {
      jobId: jobId2,
      csvImportId: csvImportId2,
      source: "dealmachine",
      market: "Kansas City",
      mapping,
      rows: firstRow,
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.skipped).toBe(0);

    const { count: afterSecond } = await supabase
      .from("properties")
      .select("*", { count: "exact", head: true });
    expect(afterSecond).toBe(2);
  });

  it("upserts repeated homeowners by name when no phone/email present", async () => {
    // The contacts table has a partial unique index on (last_name,
    // first_name) for person-type contacts with no phone and no email.
    // Re-importing a row whose owner has only a name (D4D's PH=N case)
    // must dedup against the existing name-only contact, not throw on
    // the unique constraint.
    const { jobId, csvImportId } = await createImportJob(
      "dealmachine",
      "Kansas City",
      2,
    );

    const mapping: Mapping = {
      address: "Address",
      state: "State",
      homeowner_first_name: "First",
      homeowner_last_name: "Last",
    };
    const rows: RowData[] = [
      { Address: "100 First Ave", State: "MO", First: "Jian", Last: "Shi" },
      { Address: "200 Second Ave", State: "MO", First: "Jian", Last: "Shi" },
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
    expect(summary.failed).toBe(0);

    const { count: propCount } = await supabase
      .from("properties")
      .select("*", { count: "exact", head: true });
    expect(propCount).toBe(2);

    const { count: contactCount } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true });
    expect(contactCount).toBe(1);
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
