import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  BMH_ORG_ID,
  clientForUser,
  createOrgUser,
  getCanonicalTestOrgId,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import {
  createStandaloneCassJob,
  runCassChunk,
  type CassJobSummary,
} from "./cass-job";

const supabase = createTestClient();
let userId = "";
let userClient: ReturnType<typeof clientForUser>;

function emptySummary(): CassJobSummary {
  return {
    total: 1,
    verified: 0,
    invalid: 0,
    ambiguous: 0,
    cacheHits: 0,
    failed: 0,
    providerOff: 0,
  };
}

describe("CASS job lead activity (integration)", () => {
  beforeAll(async () => {
    await resetTenantTables(supabase);
    const user = await createOrgUser(supabase, {
      orgId: BMH_ORG_ID,
      email: `cass-ledger-${crypto.randomUUID()}@bmhgroupkc.com`,
      role: "member",
    });
    userId = user.userId;
    userClient = clientForUser(user.jwt);
  });

  beforeEach(async () => {
    await resetTenantTables(supabase);
    process.env.ADDRESS_VERIFIER_PROVIDER = "mock";
  });

  afterAll(async () => {
    await supabase.auth.admin.deleteUser(userId);
    await resetTenantTables(supabase);
  });

  it("uses the durable job-item identity and stays single on replay", async () => {
    const orgId = await getCanonicalTestOrgId(supabase);
    const { data: property, error: propertyError } = await supabase
      .from("properties")
      .insert({
        org_id: orgId,
        address: "1 CASS Ledger Ln",
        city: "Kansas City",
        state: "MO",
        zip: "64111",
        status: "prospect",
      })
      .select("id")
      .single();
    expect(propertyError).toBeNull();
    const job = await createStandaloneCassJob(userClient, {
      orgId,
      propertyIds: [property!.id],
      createdBy: userId,
      requestKey: crypto.randomUUID(),
    });

    for (let attempt = 0; attempt < 2; attempt++) {
      await runCassChunk(supabase, {
        jobId: job.jobId,
        propertyIds: [property!.id],
        processedBefore: 0,
        summary: emptySummary(),
        expectedOrgId: orgId,
      });
    }

    const { data: item, error: itemError } = await supabase
      .from("job_items")
      .select("id, item_key, status")
      .eq("job_id", job.jobId)
      .eq("property_id", property!.id)
      .single();
    expect(itemError).toBeNull();
    expect(item).toMatchObject({ item_key: property!.id, status: "success" });
    const { data: events, error: eventError } = await supabase
      .from("lead_events")
      .select(
        "actor_type, actor_id, event_type, payload, source_type, source_id",
      )
      .eq("property_id", property!.id)
      .eq("event_type", "address_verified");
    expect(eventError).toBeNull();
    expect(events).toEqual([
      {
        actor_type: "system",
        actor_id: null,
        event_type: "address_verified",
        payload: {
          job_id: job.jobId,
          cass_status: "verified",
          cache_hit: false,
        },
        source_type: "job_items.cass",
        source_id: item!.id,
      },
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /CASS Ledger Ln|Kansas City|64111/,
    );
  });
});
