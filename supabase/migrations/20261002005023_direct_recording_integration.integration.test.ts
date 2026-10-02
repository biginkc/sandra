import fs from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const stripTx = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");
const ORG = "00000000-0000-0000-0000-0000000d1c01";
const USER_C = "00000000-0000-0000-0000-0000000d1a03";

it("installs the direct recording ledger, private bucket, and rollback atomically", async () => {
  const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const migration = stripTx(fs.readFileSync("supabase/migrations/20261002005023_direct_recording_integration.sql", "utf8"));
  const retryMigration = stripTx(fs.readFileSync("supabase/migrations/20261002011737_direct_recording_monotonic_retry.sql", "utf8"));
  const retryRollback = stripTx(fs.readFileSync("supabase/rollbacks/20261002011737_direct_recording_monotonic_retry.sql", "utf8"));
  const linkMigration = stripTx(fs.readFileSync("supabase/migrations/20261002013151_direct_recording_link_repair.sql", "utf8"));
  const linkRollback = stripTx(fs.readFileSync("supabase/rollbacks/20261002013151_direct_recording_link_repair.sql", "utf8"));
  const directCalls = stripTx(fs.readFileSync("supabase/migrations/20261001200000_direct_calls.sql", "utf8"));
  const rollback = stripTx(fs.readFileSync("supabase/rollbacks/20261002005023_direct_recording_integration.sql", "utf8"));
  await pg.query("begin");
  try {
    await pg.query(directCalls);
    await pg.query(migration);
    await pg.query(migration);
    await pg.query(retryMigration);
    await pg.query(retryMigration);
    await pg.query(linkMigration);
    await pg.query(linkMigration);
    const columns = await pg.query(`select table_name, column_name from information_schema.columns where table_schema='public' and ((table_name='call_activities' and column_name='direct_call_id') or (table_name='call_recordings' and column_name='provider_recording_id')) order by table_name, column_name`);
    expect(columns.rows).toEqual([
      { table_name: "call_activities", column_name: "direct_call_id" },
      { table_name: "call_recordings", column_name: "provider_recording_id" },
    ]);
    expect((await pg.query("select relrowsecurity from pg_class where oid='public.direct_call_recordings'::regclass")).rows[0].relrowsecurity).toBe(true);
    expect((await pg.query("select public, file_size_limit::bigint from storage.buckets where id='sandra-direct-recordings'")).rows[0]).toEqual({ public: false, file_size_limit: "67108864" });

    await pg.query("insert into public.organizations(id,name) values ($1,'Direct recording test') on conflict do nothing", [ORG]);
    await pg.query("insert into auth.users(id) values ($1) on conflict do nothing", [USER_C]);
    const recordingCall = "00000000-0000-4000-8000-0000000d1c41";
    const recordingProperty = "00000000-0000-4000-8000-0000000d1c42";
    const recordingContact = "00000000-0000-4000-8000-0000000d1c43";
    const recordingActivity = "00000000-0000-4000-8000-0000000d1c44";
    await pg.query("insert into public.contacts(id,org_id,first_name) values ($1,$2,'Direct recording seller')", [recordingContact, ORG]);
    await pg.query("insert into public.properties(id,org_id,address,state,homeowner_contact_id) values ($1,$2,'1 Direct Recording Way','MO',$3)", [recordingProperty, ORG, recordingContact]);
    await pg.query(
      "insert into public.direct_calls(id,org_id,operator_user_id,destination_e164,caller_id_e164,status,seller_leg_id,client_request_id) values ($1,$2,$3,'+15550000001','+15550000002','ended','seller-control',$4)",
      [recordingCall, ORG, USER_C, "00000000-0000-4000-8000-0000000d1c45"],
    );
    const firstClaim = (await pg.query(
      "select * from public.direct_call_recording_claim($1,$2,$3,$4,$5,$6,8,900)",
      [recordingCall, "provider-recording-1", "seller-control", "seller-leg", "seller-session", "2026-10-01T12:00:00Z"],
    )).rows[0];
    expect(firstClaim).toMatchObject({ should_capture: true, status: "pending", attempt_count: 1 });
    const leasedClaim = (await pg.query(
      "select * from public.direct_call_recording_claim($1,$2,$3,$4,$5,$6,8,900)",
      [recordingCall, "provider-recording-1", "seller-control", "seller-leg", "seller-session", "2026-10-01T12:00:01Z"],
    )).rows[0];
    expect(leasedClaim).toMatchObject({ should_capture: false, status: "pending", attempt_count: 1 });
    await pg.query(
      "insert into public.call_activities(id,org_id,property_id,contact_id,jitter_attempt_id,provider,operator_user_id,direct_call_id) values ($1,$2,$3,$4,$5,'sandra_softphone',$6,$7)",
      [recordingActivity, ORG, recordingProperty, recordingContact, "sandra-recording-test", USER_C, recordingCall],
    );
    await pg.query("select public.direct_call_recording_sync_activity($1,$2,$3,$4)", [recordingCall, recordingActivity, "provider-recording-1", "2026-10-01T12:00:30Z"]);
    expect((await pg.query("select status from public.call_recordings where call_activity_id=$1", [recordingActivity])).rows[0].status).toBe("pending");
    expect((await pg.query(
      "select public.direct_call_recording_mark_failed($1,$2,'capture_failed','temporary provider failure','2026-10-01T12:01:00Z')",
      ["provider-recording-1", recordingCall],
    )).rows[0].direct_call_recording_mark_failed).toBe(true);
    await pg.query("select public.direct_call_recording_sync_activity($1,$2,$3,$4)", [recordingCall, recordingActivity, "provider-recording-1", "2026-10-01T12:01:01Z"]);
    expect((await pg.query("select status from public.call_recordings where call_activity_id=$1", [recordingActivity])).rows[0].status).toBe("failed");
    expect((await pg.query(
      "select public.direct_call_recording_mark_available($1,$2,$3,$4,$5,$6)",
      ["provider-recording-1", recordingCall, "sandra-direct-recordings", `${ORG}/${recordingCall}/provider-recording-1.wav`, 7, "2026-10-01T12:02:00Z"],
    )).rows[0].direct_call_recording_mark_available).toBe(true);
    expect((await pg.query(
      "select status, linked_at, link_next_attempt_at from public.direct_call_recordings where provider_recording_id='provider-recording-1'",
    )).rows[0]).toMatchObject({ status: "available", linked_at: null });
    expect((await pg.query(
      `select count(*)::int as n
         from public.direct_call_recordings
        where status = 'available'
          and linked_at is null
          and link_attempt_count < 8
          and link_next_attempt_at <= '2026-10-01T12:02:00Z'`,
    )).rows[0].n).toBe(1);
    // The final activity sync is deliberately skipped. The available row must
    // remain a real sweep candidate so a transient handler failure is repaired.
    expect((await pg.query("select status from public.call_recordings where call_activity_id=$1", [recordingActivity])).rows[0].status).toBe("failed");
    await pg.query("select public.direct_call_recording_sync_activity($1,$2,$3,$4)", [recordingCall, recordingActivity, "provider-recording-1", "2026-10-01T12:02:01Z"]);
    expect((await pg.query("select status,storage_path,provider_recording_id from public.call_recordings where call_activity_id=$1", [recordingActivity])).rows[0]).toEqual({
      status: "available",
      storage_path: `${ORG}/${recordingCall}/provider-recording-1.wav`,
      provider_recording_id: "provider-recording-1",
    });
    expect((await pg.query(
      `select count(*)::int as n
         from public.direct_call_recordings
        where status = 'available'
          and linked_at is null
          and link_attempt_count < 8
          and link_next_attempt_at <= '2026-10-01T12:02:01Z'`,
    )).rows[0].n).toBe(0);
    expect((await pg.query(
      "select public.direct_call_recording_mark_failed($1,$2,'capture_failed','stale failure','2026-10-01T12:02:00Z')",
      ["provider-recording-1", recordingCall],
    )).rows[0].direct_call_recording_mark_failed).toBe(false);
    expect((await pg.query("select status from public.direct_call_recordings where provider_recording_id='provider-recording-1'")).rows[0].status).toBe("available");

    await pg.query(linkRollback);
    await pg.query(retryRollback);
    await pg.query(rollback);
    expect((await pg.query("select to_regclass('public.direct_call_recordings') as table_name")).rows[0].table_name).toBeNull();
    expect((await pg.query("select 1 from information_schema.columns where table_schema='public' and table_name='call_activities' and column_name='direct_call_id'")).rowCount).toBe(0);
    expect((await pg.query("select public from storage.buckets where id='sandra-direct-recordings'")).rows[0].public).toBe(false);
  } finally {
    await pg.query("rollback").catch(() => undefined);
    await pg.end();
  }
});
