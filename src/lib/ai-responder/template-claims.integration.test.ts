import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { TEMPLATE_SENT_MISSING_OUTCOME, TEMPLATE_SENT_PENDING_OUTCOME } from "./claims";
import { sweepTemplateSentClaims } from "./template-claims";

/**
 * Stale-claim sweeper for the template step. Local-only: the REAL sweeper query
 * runs through a real PostgREST against committed local rows, so the filter
 * combination (marker AND status AND outbound id AND lease) is proven, then the
 * flag it writes and the one-shot retirement of the marker.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const orgId = randomUUID();
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const minutesAhead = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

const props: Record<string, string> = {};
const claimIds: Record<string, string> = {};

async function seedMessage(direction: "inbound" | "outbound") {
  const id = randomUUID();
  await db.query(
    `insert into public.messages (id, org_id, channel, direction, body, status) values ($1, $2, 'sms', $3, 'x', 'delivered')`,
    [id, orgId, direction],
  );
  return id;
}

async function seedClaim(
  key: string,
  over: { outcome: string | null; status: string; lease: string; withOutbound?: boolean },
) {
  const propertyId = randomUUID();
  props[key] = propertyId;
  await db.query(
    `insert into public.properties (id, org_id, address, state, needs_human_attention) values ($1, $2, '1 Test St', 'MO', false)`,
    [propertyId, orgId],
  );
  const inbound = await seedMessage("inbound");
  const outbound = over.withOutbound === false ? null : await seedMessage("outbound");
  const { rows } = await db.query(
    `insert into public.ai_response_claims
       (org_id, inbound_message_id, property_id, status, lease_expires_at, outbound_message_id, outcome)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [orgId, inbound, propertyId, over.status, over.lease, outbound, over.outcome],
  );
  claimIds[key] = rows[0].id;
}

describe("template-sent stale-claim sweeper", () => {
  beforeAll(async () => {
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await db.connect();
    await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Template sweep ${orgId}`]);
  });
  afterAll(async () => {
    await db.query("delete from public.ai_response_claims where org_id = $1", [orgId]).catch(() => undefined);
    await db.query("delete from public.messages where org_id = $1", [orgId]).catch(() => undefined);
    await db.query("delete from public.properties where org_id = $1", [orgId]).catch(() => undefined);
    await db.query("delete from public.organizations where id = $1", [orgId]).catch(() => undefined);
    await db.end();
  });

  it("flags exactly the claims that sent a template and never applied the outcome, once", async () => {
    // Swept: marker + stale lease, whether the claim is still processing or parked in error.
    await seedClaim("processing", { outcome: TEMPLATE_SENT_PENDING_OUTCOME, status: "processing", lease: minutesAgo(30) });
    await seedClaim("errored", { outcome: TEMPLATE_SENT_PENDING_OUTCOME, status: "error", lease: minutesAgo(30) });
    // Not swept.
    await seedClaim("live-lease", { outcome: TEMPLATE_SENT_PENDING_OUTCOME, status: "processing", lease: minutesAhead(3) });
    await seedClaim("within-grace", { outcome: TEMPLATE_SENT_PENDING_OUTCOME, status: "processing", lease: minutesAgo(1) });
    await seedClaim("applied", { outcome: "auto_closed", status: "completed", lease: minutesAgo(30) });
    await seedClaim("completed-marker", { outcome: TEMPLATE_SENT_PENDING_OUTCOME, status: "completed", lease: minutesAgo(30) });
    await seedClaim("already-flagged", { outcome: TEMPLATE_SENT_MISSING_OUTCOME, status: "error", lease: minutesAgo(30) });
    await seedClaim("no-outbound", { outcome: TEMPLATE_SENT_PENDING_OUTCOME, status: "processing", lease: minutesAgo(30), withOutbound: false });

    const supabase = createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const out = await sweepTemplateSentClaims(supabase as never, { limit: 1000 });
    expect(out.failed).toBe(0);
    expect(out.flagged).toBeGreaterThanOrEqual(2);

    const flagged = await db.query(
      `select id, needs_human_attention, last_ai_escalation_reason from public.properties where org_id = $1 order by id`,
      [orgId],
    );
    const byId = new Map(flagged.rows.map((r) => [r.id as string, r]));
    for (const key of ["processing", "errored"]) {
      expect(byId.get(props[key]!)).toMatchObject({
        needs_human_attention: true,
        last_ai_escalation_reason: "template_sent_outcome_missing",
      });
    }
    for (const key of ["live-lease", "within-grace", "applied", "completed-marker", "already-flagged", "no-outbound"]) {
      expect(byId.get(props[key]!)).toMatchObject({ needs_human_attention: false });
    }

    const claims = await db.query(
      `select id, outcome, status, error_message from public.ai_response_claims where org_id = $1`,
      [orgId],
    );
    const claim = new Map(claims.rows.map((r) => [r.id as string, r]));
    expect(claim.get(claimIds.processing!)).toMatchObject({
      outcome: TEMPLATE_SENT_MISSING_OUTCOME,
      status: "error",
      error_message: TEMPLATE_SENT_MISSING_OUTCOME,
    });
    expect(claim.get(claimIds["live-lease"]!)).toMatchObject({ outcome: TEMPLATE_SENT_PENDING_OUTCOME });

    // One-shot: a second sweep finds nothing of ours.
    await db.query(
      `update public.properties set needs_human_attention = false, last_ai_escalation_reason = null where org_id = $1`,
      [orgId],
    );
    await sweepTemplateSentClaims(supabase as never, { limit: 1000 });
    const again = await db.query(`select count(*)::int as n from public.properties where org_id = $1 and needs_human_attention`, [orgId]);
    expect(again.rows[0].n).toBe(0);
  });
});
