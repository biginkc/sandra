import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { normalizeAddress } from "@/lib/csv/normalize";
import { previewBulkUpdate, applyBulkUpdate } from "@/lib/csv/update-bulk";
import { createTestClient } from "@tests/integration/client";
import { resetTenantTables } from "@tests/integration/reset";

const supabase = createTestClient();
let actorId = "";

beforeAll(async () => {
  const { data, error } = await supabase.auth.admin.createUser({
    email: `csv-ledger-${crypto.randomUUID()}@test.invalid`,
    password: `test-pw-${crypto.randomUUID()}`,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw error ?? new Error("CSV ledger actor creation failed");
  }
  actorId = data.user.id;
});

afterAll(async () => {
  if (actorId) await supabase.auth.admin.deleteUser(actorId);
});

async function seedProperty(
  address: string,
  status = "new_lead",
): Promise<string> {
  const { data, error } = await supabase
    .from("properties")
    .insert({
      address,
      address_normalized: normalizeAddress(address),
      state: "MO",
      status,
      market: "Kansas City",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("seedProperty failed");
  return data.id;
}

async function readStatus(id: string): Promise<string> {
  const { data } = await supabase
    .from("properties")
    .select("status")
    .eq("id", id)
    .single();
  return data!.status;
}

async function createUpdateJob(totalRows: number): Promise<string> {
  const { data, error } = await supabase
    .from("jobs")
    .insert({
      type: "csv_update",
      status: "queued",
      total_items: totalRows,
      title: "Integration test update",
    })
    .select("id")
    .single();
  if (error || !data) throw error ?? new Error("createUpdateJob failed");
  return data.id;
}

describe("update-bulk runner (integration)", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("end-to-end: 10-row sheet → 8 matched + 2 unmatched, writes only for matched", async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 8; i++) ids.push(await seedProperty(`${i} Row St`));
    const rows = [
      ...Array.from({ length: 8 }, (_, i) => ({
        Address: `${i + 1} Row St`,
        Status: "contacted",
      })),
      { Address: "999 Missing St", Status: "contacted" },
      { Address: "888 AlsoMissing St", Status: "contacted" },
    ];

    const preview = await previewBulkUpdate(supabase, {
      subOperationId: "update-property-status",
      rows,
    });
    expect(preview.matched.length).toBe(8);
    expect(preview.unmatched.length).toBe(2);
    expect(preview.totalRows).toBe(10);
    // Preview must not write.
    for (const id of ids) expect(await readStatus(id)).toBe("new_lead");

    const jobId = await createUpdateJob(10);
    const summary = await applyBulkUpdate(supabase, {
      subOperationId: "update-property-status",
      rows,
      userId: null,
      jobId,
    });
    expect(summary.matchedCount).toBe(8);
    expect(summary.updatedCount).toBe(8);
    expect(summary.failedCount).toBe(2);
    for (const id of ids) expect(await readStatus(id)).toBe("contacted");
  });

  it("last-write-wins: same address in 2 rows with different statuses → final state matches LAST row", async () => {
    const id = await seedProperty("100 Twice St");
    const rows = [
      { Address: "100 Twice St", Status: "contacted" },
      { Address: "100 Twice St", Status: "interested" },
    ];
    const jobId = await createUpdateJob(2);
    await applyBulkUpdate(supabase, {
      subOperationId: "update-property-status",
      rows,
      userId: null,
      jobId,
    });
    expect(await readStatus(id)).toBe("interested");
  });

  it("preview surfaces a duplicate-address warning when the same address appears twice", async () => {
    await seedProperty("200 Dup St");
    const preview = await previewBulkUpdate(supabase, {
      subOperationId: "update-property-status",
      rows: [
        { Address: "200 Dup St", Status: "contacted" },
        { Address: "200 Dup St", Status: "interested" },
      ],
    });
    expect(preview.duplicateAddresses).toContain(
      normalizeAddress("200 Dup St"),
    );
  });

  it("bulk-update job: status flips queued → running → completed; counters populated", async () => {
    const id = await seedProperty("300 Job St");
    const jobId = await createUpdateJob(2);
    await applyBulkUpdate(supabase, {
      subOperationId: "update-property-status",
      rows: [
        { Address: "300 Job St", Status: "contacted" },
        { Address: "300 Missing St", Status: "contacted" },
      ],
      userId: null,
      jobId,
    });
    const { data } = await supabase
      .from("jobs")
      .select(
        "status, processed_items, succeeded_items, failed_items, started_at, completed_at",
      )
      .eq("id", jobId)
      .single();
    expect(data!.status).toBe("completed");
    expect(data!.processed_items).toBe(2);
    expect(data!.succeeded_items).toBe(1);
    expect(data!.failed_items).toBe(1);
    expect(data!.started_at).not.toBeNull();
    expect(data!.completed_at).not.toBeNull();
    expect(await readStatus(id)).toBe("contacted");
  });

  it("aggregates unknown-tag names across rows into a deduped list (case-insensitive)", async () => {
    await seedProperty("400 TagDup St");
    await seedProperty("401 TagDup St");
    await seedProperty("402 TagDup St");
    const preview = await previewBulkUpdate(supabase, {
      subOperationId: "tag-existing-properties",
      rows: [
        { Address: "400 TagDup St", Tags: "Schmurf" },
        { Address: "401 TagDup St", Tags: "SCHMURF" },
        { Address: "402 TagDup St", Tags: "schmurf" },
      ],
    });
    expect(preview.unknownTags).toEqual(["schmurf"]);
    expect(preview.unmatched.length).toBe(3);
  });

  it("records only confirmed status changes with truthful batch metadata", async () => {
    const firstId = await seedProperty("500 Ledger Status A");
    const secondId = await seedProperty("501 Ledger Status B");
    const jobId = await createUpdateJob(2);

    const first = await applyBulkUpdate(supabase, {
      subOperationId: "update-property-status",
      rows: [
        { Address: "500 Ledger Status A", Status: "contacted" },
        { Address: "501 Ledger Status B", Status: "contacted" },
      ],
      userId: actorId,
      jobId,
    });
    expect(first.updatedCount).toBe(2);

    const { data: events, error } = await supabase
      .from("lead_events")
      .select("property_id, actor_type, actor_id, event_type, payload")
      .in("property_id", [firstId, secondId])
      .eq("event_type", "status_changed");
    expect(error).toBeNull();
    expect(events).toHaveLength(2);
    const statusEvents = (events ?? []) as Array<{
      actor_id: string | null;
      actor_type: string;
      payload: Record<string, unknown>;
    }>;
    expect(new Set(statusEvents.map((event) => event.actor_id))).toEqual(
      new Set([actorId]),
    );
    expect(
      new Set(statusEvents.map((event) => event.payload.batch_id)),
    ).toHaveProperty("size", 1);
    expect(
      statusEvents.every(
        (event) =>
          event.actor_type === "user" &&
          event.payload.from === "new_lead" &&
          event.payload.to === "contacted" &&
          event.payload.batch_count === 2,
      ),
    ).toBe(true);

    const replayJob = await createUpdateJob(2);
    const replay = await applyBulkUpdate(supabase, {
      subOperationId: "update-property-status",
      rows: [
        { Address: "500 Ledger Status A", Status: "contacted" },
        { Address: "501 Ledger Status B", Status: "contacted" },
      ],
      userId: actorId,
      jobId: replayJob,
    });
    expect(replay.updatedCount).toBe(0);
    const { count } = await supabase
      .from("lead_events")
      .select("id", { count: "exact", head: true })
      .in("property_id", [firstId, secondId])
      .eq("event_type", "status_changed");
    expect(count).toBe(2);
  });

  it("records motivation and only newly inserted tag associations", async () => {
    const propertyId = await seedProperty("600 Ledger Fields");
    const motivationJob = await createUpdateJob(1);
    const motivation = await applyBulkUpdate(supabase, {
      subOperationId: "update-motivation-level",
      rows: [{ Address: "600 Ledger Fields", Motivation: "hot" }],
      userId: actorId,
      jobId: motivationJob,
    });
    expect(motivation.updatedCount).toBe(1);

    const { data: tag, error: tagError } = await supabase
      .from("tags")
      .insert({ name: "Ledger tag", category: "custom" })
      .select("id")
      .single();
    expect(tagError).toBeNull();
    const tagJob = await createUpdateJob(1);
    const tagApply = await applyBulkUpdate(supabase, {
      subOperationId: "tag-existing-properties",
      rows: [{ Address: "600 Ledger Fields", Tags: "Ledger tag" }],
      userId: actorId,
      jobId: tagJob,
    });
    expect(tagApply.updatedCount).toBe(1);

    const replayJob = await createUpdateJob(1);
    const replay = await applyBulkUpdate(supabase, {
      subOperationId: "tag-existing-properties",
      rows: [{ Address: "600 Ledger Fields", Tags: "Ledger tag" }],
      userId: actorId,
      jobId: replayJob,
    });
    expect(replay.updatedCount).toBe(0);

    const { data: events, error: eventsError } = await supabase
      .from("lead_events")
      .select("event_type, actor_id, payload")
      .eq("property_id", propertyId)
      .in("event_type", ["motivation_changed", "tag_applied"])
      .order("event_type");
    expect(eventsError).toBeNull();
    expect(events).toHaveLength(2);
    expect(events).toEqual([
      expect.objectContaining({
        event_type: "motivation_changed",
        actor_id: actorId,
        payload: expect.objectContaining({
          from: null,
          to: "hot",
          batch_count: 1,
        }),
      }),
      expect.objectContaining({
        event_type: "tag_applied",
        actor_id: actorId,
        payload: expect.objectContaining({
          tag_id: tag!.id,
          label: "Ledger tag",
          batch_count: 1,
        }),
      }),
    ]);
  });
});
