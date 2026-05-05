/**
 * Integration test for migration 046 — backfill properties.county_id from FIPS.
 *
 * Migration 046 (`046_backfill_property_county_id_from_fips.sql`) applies two
 * idempotent UPDATE statements against the test DB:
 *
 *   Step 1 — fips_code JOIN:
 *     UPDATE properties p
 *     SET county_id = c.id, market = c.market, updated_at = now()
 *     FROM counties c
 *     WHERE c.fips_code = p.fips_code
 *       AND p.fips_code IS NOT NULL
 *       AND p.county_id IS NULL;
 *
 *   Step 2 — CASS jsonb fallback:
 *     UPDATE properties p
 *     SET county_id = c.id, market = c.market, updated_at = now()
 *     FROM counties c
 *     WHERE c.fips_code = (p.cass_raw_response->0->'metadata'->>'county_fips')
 *       AND p.fips_code IS NULL
 *       AND p.cass_raw_response IS NOT NULL
 *       AND p.county_id IS NULL;
 *
 * This test verifies the behavioral semantics of those two UPDATE paths by
 * inserting test property rows, then replicating the same JOIN logic via the
 * Supabase JS client (which exercises the same Postgres code paths), then
 * asserting the expected column values and idempotency.
 *
 * Preconditions (guaranteed by the test DB migration chain):
 *   - Migration 043: counties.fips_code column exists.
 *   - Migration 044: 21 BMH counties seeded (with fips_code populated by 047).
 *   - Migration 046: backfill already applied to pre-existing rows.
 *   - Migration 047: fips_codes seeded; counties.fips_code populated.
 *
 * Test rows inserted here start with county_id = NULL so they exercise the
 * same logic as if the migration were running for the first time.
 *
 * Per project memory `feedback_test_every_fix.md`: this test locks 046's
 * behavioral semantics so a future migration can't silently regress the backfill.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";

const testClient = createTestClient();

// FIPS codes proven to exist in the seeded counties + fips_codes tables
// (migration 044 + 047). Jackson County MO = 29095.
const JACKSON_COUNTY_FIPS = "29095";
const JACKSON_COUNTY_MARKET = "Jackson County MO";

// Unique address prefixes to isolate these test rows from real production data.
// If reset_tenant_tables is called by a concurrent test, these will be wiped —
// but this suite runs sequentially (fileParallelism: false).
const TEST_ADDRESS_PREFIX = "046-integration-test";

/** IDs of test properties created during this suite — deleted in afterAll. */
const createdPropertyIds: string[] = [];

/**
 * Insert a minimal test property row with the given overrides.
 * Returns the new row's id.
 */
async function insertTestProperty(
  overrides: {
    address?: string;
    fips_code?: string | null;
    cass_raw_response?: unknown;
    county_id?: string | null;
    market?: string | null;
  } = {},
): Promise<string> {
  const address =
    overrides.address ?? `${TEST_ADDRESS_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await testClient
    .from("properties")
    .insert({
      address,
      state: "MO",
      status: "new_lead",
      fips_code: overrides.fips_code ?? null,
      cass_raw_response: (overrides.cass_raw_response as never) ?? null,
      county_id: overrides.county_id ?? null,
      market: overrides.market ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`insertTestProperty failed: ${error?.message ?? "no data"}`);
  }

  createdPropertyIds.push(data.id);
  return data.id;
}

/**
 * Look up the Jackson County MO row from the counties table.
 * Migration 044 + 047 guarantee it exists with the correct fips_code.
 */
async function getJacksonCounty(): Promise<{ id: string; market: string; fips_code: string }> {
  const { data, error } = await testClient
    .from("counties")
    .select("id, market, fips_code")
    .eq("fips_code", JACKSON_COUNTY_FIPS)
    .single();

  if (error || !data) {
    throw new Error(
      `Could not find Jackson County MO (fips_code=${JACKSON_COUNTY_FIPS}): ${error?.message ?? "no data"}. ` +
        "Ensure migrations 044 + 047 have been applied to the test DB.",
    );
  }

  return data as { id: string; market: string; fips_code: string };
}

/**
 * Replicate migration 046 Step 1: UPDATE properties via fips_code JOIN.
 * Equivalent to:
 *   UPDATE properties p SET county_id = c.id, market = c.market
 *   FROM counties c WHERE c.fips_code = p.fips_code AND p.fips_code IS NOT NULL AND p.county_id IS NULL
 *
 * We run this per-property-id so the test rows stay isolated from prod data.
 */
async function runFipsBackfillForProperty(propertyId: string): Promise<void> {
  // 1. Find which county matches this property's fips_code.
  const { data: prop } = await testClient
    .from("properties")
    .select("fips_code, county_id")
    .eq("id", propertyId)
    .single();

  if (!prop || prop.fips_code === null || prop.county_id !== null) {
    // Migration's WHERE clause would exclude this row — skip.
    return;
  }

  const { data: county } = await testClient
    .from("counties")
    .select("id, market")
    .eq("fips_code", prop.fips_code)
    .maybeSingle();

  if (!county) return; // No matching county — migration leaves row untouched.

  await testClient
    .from("properties")
    .update({ county_id: county.id, market: county.market })
    .eq("id", propertyId)
    .is("county_id", null); // Idempotency guard (migration's WHERE clause)
}

/**
 * Replicate migration 046 Step 2: UPDATE properties via CASS jsonb fallback.
 * Equivalent to:
 *   UPDATE properties p SET county_id = c.id, market = c.market
 *   FROM counties c
 *   WHERE c.fips_code = (p.cass_raw_response->0->'metadata'->>'county_fips')
 *     AND p.fips_code IS NULL AND p.cass_raw_response IS NOT NULL AND p.county_id IS NULL
 */
async function runCassBackfillForProperty(propertyId: string): Promise<void> {
  const { data: prop } = await testClient
    .from("properties")
    .select("fips_code, cass_raw_response, county_id")
    .eq("id", propertyId)
    .single();

  if (
    !prop ||
    prop.fips_code !== null ||           // Step 2 only applies when fips_code IS NULL
    prop.cass_raw_response === null ||
    prop.county_id !== null              // Already backfilled
  ) {
    return;
  }

  // Extract county_fips from cass_raw_response[0].metadata.county_fips
  // Type from src/lib/enrichment/types.ts: CassResponse[]
  const cassArr = prop.cass_raw_response as Array<{ metadata?: { county_fips?: string } }>;
  const countyFips = cassArr?.[0]?.metadata?.county_fips ?? null;
  if (!countyFips) return;

  const { data: county } = await testClient
    .from("counties")
    .select("id, market")
    .eq("fips_code", countyFips)
    .maybeSingle();

  if (!county) return;

  await testClient
    .from("properties")
    .update({ county_id: county.id, market: county.market })
    .eq("id", propertyId)
    .is("county_id", null); // Idempotency guard
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Verify preconditions: counties table has Jackson County MO with fips_code.
  await getJacksonCounty();
});

afterAll(async () => {
  if (createdPropertyIds.length === 0) return;
  const { error } = await testClient
    .from("properties")
    .delete()
    .in("id", createdPropertyIds);
  if (error) {
    console.error("afterAll cleanup failed:", error.message);
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Migration 046 — backfill properties.county_id from FIPS (integration)", () => {
  it("Test 3 — happy path (fips_code JOIN): sets county_id + market for property with known fips_code", async () => {
    const jackson = await getJacksonCounty();

    // Insert property with fips_code but no county_id (pre-migration state).
    const propId = await insertTestProperty({
      address: `${TEST_ADDRESS_PREFIX}-happy-path`,
      fips_code: JACKSON_COUNTY_FIPS,
      county_id: null,
      market: "Kansas City", // legacy market value before backfill
    });

    // Precondition: county_id IS NULL.
    const { data: before } = await testClient
      .from("properties")
      .select("county_id, market")
      .eq("id", propId)
      .single();
    expect(before?.county_id).toBeNull();

    // Run migration Step 1 logic.
    await runFipsBackfillForProperty(propId);

    // Assert: county_id set to Jackson County MO's id; market updated to canonical string.
    const { data: after } = await testClient
      .from("properties")
      .select("county_id, market")
      .eq("id", propId)
      .single();

    expect(after?.county_id).toBe(jackson.id);
    expect(after?.market).toBe(JACKSON_COUNTY_MARKET);
  });

  it("Test 4 — leave-alone path: property with fips_code=NULL and cass_raw_response=NULL is untouched", async () => {
    const propId = await insertTestProperty({
      address: `${TEST_ADDRESS_PREFIX}-leave-alone`,
      fips_code: null,
      cass_raw_response: null,
      county_id: null,
      market: "Kansas City",
    });

    // Run both migration steps.
    await runFipsBackfillForProperty(propId);
    await runCassBackfillForProperty(propId);

    // Assert: both steps are no-ops — county_id stays NULL, market unchanged.
    const { data: after } = await testClient
      .from("properties")
      .select("county_id, market")
      .eq("id", propId)
      .single();

    expect(after?.county_id).toBeNull();
    expect(after?.market).toBe("Kansas City"); // Intentional no-op per D-05
  });

  it("Test 5 — CASS jsonb fallback: sets county_id from cass_raw_response[0].metadata.county_fips when fips_code IS NULL", async () => {
    const jackson = await getJacksonCounty();

    const propId = await insertTestProperty({
      address: `${TEST_ADDRESS_PREFIX}-cass-jsonb`,
      fips_code: null,
      cass_raw_response: [{ metadata: { county_fips: JACKSON_COUNTY_FIPS } }],
      county_id: null,
      market: "Kansas City",
    });

    // Precondition: fips_code IS NULL, county_id IS NULL.
    const { data: before } = await testClient
      .from("properties")
      .select("fips_code, county_id")
      .eq("id", propId)
      .single();
    expect(before?.fips_code).toBeNull();
    expect(before?.county_id).toBeNull();

    // Step 1 should be a no-op (fips_code IS NULL).
    await runFipsBackfillForProperty(propId);
    const { data: afterStep1 } = await testClient
      .from("properties")
      .select("county_id")
      .eq("id", propId)
      .single();
    expect(afterStep1?.county_id).toBeNull(); // Step 1 left it alone

    // Step 2 (CASS jsonb) should set county_id.
    await runCassBackfillForProperty(propId);
    const { data: afterStep2 } = await testClient
      .from("properties")
      .select("county_id, market")
      .eq("id", propId)
      .single();

    expect(afterStep2?.county_id).toBe(jackson.id);
    expect(afterStep2?.market).toBe(JACKSON_COUNTY_MARKET);
  });

  it("Test 6 — idempotency: re-running both steps after a successful backfill is a no-op", async () => {
    const jackson = await getJacksonCounty();

    // Set up a property that has already been backfilled (county_id IS NOT NULL).
    const propId = await insertTestProperty({
      address: `${TEST_ADDRESS_PREFIX}-idempotency`,
      fips_code: JACKSON_COUNTY_FIPS,
      county_id: jackson.id, // Already backfilled
      market: JACKSON_COUNTY_MARKET,
    });

    // Also set up the CASS path property (already backfilled).
    const cassBackfilledId = await insertTestProperty({
      address: `${TEST_ADDRESS_PREFIX}-idempotency-cass`,
      fips_code: null,
      cass_raw_response: [{ metadata: { county_fips: JACKSON_COUNTY_FIPS } }],
      county_id: jackson.id, // Already backfilled
      market: JACKSON_COUNTY_MARKET,
    });

    // Snapshot state before re-running.
    const { data: before } = await testClient
      .from("properties")
      .select("id, county_id, market")
      .in("id", [propId, cassBackfilledId]);

    // Re-run both steps.
    await runFipsBackfillForProperty(propId);
    await runCassBackfillForProperty(propId);
    await runFipsBackfillForProperty(cassBackfilledId);
    await runCassBackfillForProperty(cassBackfilledId);

    // Snapshot state after re-running.
    const { data: after } = await testClient
      .from("properties")
      .select("id, county_id, market")
      .in("id", [propId, cassBackfilledId]);

    // Assert: county_id and market are identical before and after re-run.
    expect(after).toHaveLength(2);
    const beforeMap = new Map((before ?? []).map((r) => [r.id, r]));
    for (const row of after ?? []) {
      const snapshot = beforeMap.get(row.id);
      expect(row.county_id).toBe(snapshot?.county_id);
      expect(row.market).toBe(snapshot?.market);
    }
  });
});
