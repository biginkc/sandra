import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Local-only migration replay test. Run with `npm run test:integration:local`.
 * It deliberately rejects hosted database URLs and is excluded from
 * `npm run test:integration`.
 */
const localDbUrl = "postgresql://postgres:postgres@127.0.0.1:54329/postgres";
const migrationPath = path.resolve(__dirname, "20260927023443_dialpad_cti_kpi_seller_speech.sql");
const legacyPath = path.resolve(__dirname, "20260917193000_recording_accountability.sql");
const migrationSql = readFileSync(migrationPath, "utf8");
const legacySql = readFileSync(legacyPath, "utf8");
const legacyKpiSql = `${legacySql.slice(
  legacySql.indexOf("begin;"),
  legacySql.indexOf("create or replace function public.recording_library_rows"),
)}commit;`;

let pg: Client;
let orgId = "";
let memberId = "";
let propertyId = "";
let contactId = "";

function requireLocalDb(): string {
  const url = process.env.TEST_SUPABASE_DB_URL ?? localDbUrl;
  const parsed = new URL(url);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Dialpad CTI KPI integration tests must run against local Supabase only.");
  }
  return url;
}

async function seedFixture(): Promise<void> {
  await pg.query("insert into auth.users(id) values ($1)", [memberId]);
  await pg.query("insert into public.organizations(id,name) values ($1,$2)", [orgId, `CTI KPI ${orgId}`]);
  await pg.query("set local role service_role");
  await pg.query("select set_config('request.jwt.claim.role','service_role',true)");
  await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [memberId, orgId]);
  await pg.query("reset role");
  await pg.query("insert into public.acquisition_org_settings(org_id,my_leads_enabled) values ($1,true)", [orgId]);
  await pg.query("insert into public.contacts(id,org_id,first_name) values ($1,$2,'KPI')", [contactId, orgId]);
  await pg.query(
    "insert into public.properties(id,org_id,address,state,homeowner_contact_id,assigned_user_id) values ($1,$2,'1 KPI Way','MO',$3,$4)",
    [propertyId, orgId, contactId, memberId],
  );
}

async function addCall(input: {
  provider: "dialpad" | "jitter" | null;
  talk: number;
  measured?: number;
  confidence?: "full" | "partial" | "low";
}): Promise<void> {
  const callId = crypto.randomUUID();
  await pg.query(
    `insert into public.call_activities(
       id,org_id,property_id,contact_id,jitter_attempt_id,jitter_session_id,provider,started_at,ended_at,
       talk_duration_seconds,seller_speech_seconds_measured,seller_speech_confidence
     ) values ($1,$2,$3,$4,$5,$6,$7,'2026-09-01T12:00:00Z','2026-09-01T12:10:00Z',$8,$9,$10)`,
    [callId, orgId, propertyId, contactId, crypto.randomUUID(), input.provider === "jitter" ? crypto.randomUUID() : null, input.provider, input.talk, input.measured ?? null, input.confidence ?? null],
  );
  await pg.query(
    `insert into public.acquisition_attempts(
       org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,call_activity_id,idempotency_key
     ) values ($1,$2,$3,'call','dialpad','reached','2026-09-01T12:00:00Z',$4,$5)`,
    [orgId, propertyId, memberId, callId, crypto.randomUUID()],
  );
}

async function kpis(): Promise<Record<string, unknown>> {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [memberId]);
  const result = await pg.query<{ value: Record<string, unknown> }>(
    "select public.fn_get_acquisition_kpis($1,$2,'2026-09-01T00:00:00Z','2026-09-02T00:00:00Z') as value",
    [orgId, memberId],
  );
  await pg.query("reset role");
  return result.rows[0]!.value;
}

async function compareLegacyAndCurrentKpis(): Promise<Record<string, unknown>> {
  await pg.query("set local role authenticated");
  await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [memberId]);
  const result = await pg.query<{ value: Record<string, unknown> }>(
    `select jsonb_build_object(
       'legacy', public.fn_get_acquisition_kpis_legacy_test($1,$2,'2026-09-01T00:00:00Z','2026-09-02T00:00:00Z'),
       'current', public.fn_get_acquisition_kpis($1,$2,'2026-09-01T00:00:00Z','2026-09-02T00:00:00Z')
     ) as value`,
    [orgId, memberId],
  );
  await pg.query("reset role");
  return result.rows[0]!.value;
}

describe("20260927023443 Dialpad CTI seller speech KPI migration", () => {
  beforeAll(async () => {
    pg = new Client({ connectionString: requireLocalDb() });
    await pg.connect();
    await pg.query(migrationSql);
    await pg.query(migrationSql);
  });

  afterAll(async () => {
    await pg.end();
  });

  beforeEach(async () => {
    orgId = crypto.randomUUID();
    memberId = crypto.randomUUID();
    propertyId = crypto.randomUUID();
    contactId = crypto.randomUUID();
    await pg.query("begin");
    await seedFixture();
  });

  afterEach(async () => {
    await pg.query("rollback");
    await pg.query("reset role");
  });

  it("is additive for old call writers and enforces the new value domains", async () => {
    const legacyCall = crypto.randomUUID();
    await pg.query(
      "insert into public.call_activities(id,org_id,property_id,contact_id,jitter_attempt_id,provider) values ($1,$2,$3,$4,$5,'dialpad')",
      [legacyCall, orgId, propertyId, contactId, crypto.randomUUID()],
    );
    const result = await pg.query("select seller_speech_seconds_measured,seller_speech_seconds_estimated,seller_speech_confidence from public.call_activities where id=$1", [legacyCall]);
    expect(result.rows[0]).toEqual({ seller_speech_seconds_measured: null, seller_speech_seconds_estimated: null, seller_speech_confidence: null });
    await pg.query("savepoint invalid_measured");
    await expect(pg.query("update public.call_activities set seller_speech_seconds_measured=-1 where id=$1", [legacyCall])).rejects.toThrow(/check constraint/i);
    await pg.query("rollback to savepoint invalid_measured");
    await pg.query("savepoint invalid_confidence");
    await expect(pg.query("update public.call_activities set seller_speech_confidence='unknown' where id=$1", [legacyCall])).rejects.toThrow(/check constraint/i);
    await pg.query("rollback to savepoint invalid_confidence");
  });

  it.each([
    ["does not count exactly 300 measured seconds", { provider: "dialpad", talk: 600, measured: 300, confidence: "full" }, 0],
    ["counts 301 measured seconds", { provider: "dialpad", talk: 0, measured: 301, confidence: "full" }, 1],
    ["does not fall back to talk duration for Dialpad without a measurement", { provider: "dialpad", talk: 600 }, 0],
    ["uses talk duration when the provider is NULL", { provider: null, talk: 301 }, 1],
    ["does not count partial-confidence speech", { provider: "dialpad", talk: 600, measured: 400, confidence: "partial" }, 0],
    ["does not count low-confidence speech", { provider: "dialpad", talk: 600, measured: 400, confidence: "low" }, 0],
  ] satisfies ReadonlyArray<[string, Parameters<typeof addCall>[0], number]>)
  ("%s", async (_description, call, expectedConversations) => {
    // The current column is NOT NULL, but the SQL deliberately handles
    // historical NULL providers. Make that legacy shape available only inside
    // this fixture transaction; afterEach rolls the DDL back.
    if (call.provider === null) {
      await pg.query("alter table public.call_activities alter column provider drop not null");
    }
    await addCall(call);
    const result = await kpis();
    expect(result.conversationsOverFiveMinutes).toBe(expectedConversations);
  });

  it("preserves every non-CTI KPI field from the September 17 definition", async () => {
    await pg.query("rollback");
    await pg.query("reset role");

    await pg.query(legacyKpiSql);
    await pg.query(
      "alter function public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz) rename to fn_get_acquisition_kpis_legacy_test",
    );
    await pg.query(migrationSql);
    await pg.query("begin");
    await seedFixture();
    await addCall({ provider: "jitter", talk: 600 });
    const comparison = await compareLegacyAndCurrentKpis();
    await pg.query("rollback");
    await pg.query("reset role");
    await pg.query("drop function public.fn_get_acquisition_kpis_legacy_test(uuid,uuid,timestamptz,timestamptz)");

    // Both functions execute in the same SQL statement, so statement_timestamp()
    // (and therefore asOf) is identical. Compare their full outputs.
    expect(comparison.current).toEqual(comparison.legacy);
  });
});
