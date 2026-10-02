import fs from "node:fs";

import { Client } from "pg";
import { expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const stripTx = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");
const ORG = "00000000-0000-0000-0000-000000000bbb";
const USER = "00000000-0000-4000-8000-000000015001";
const OTHER_USER = "00000000-0000-4000-8000-000000015002";

it("catalogs direct recordings in the Sandra library with owner and mine scope", async () => {
  const url = requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres");
  const pg = new Client({ connectionString: url });
  await pg.connect();
  const directCalls = stripTx(fs.readFileSync("supabase/migrations/20261001200000_direct_calls.sql", "utf8"));
  const recording = stripTx(fs.readFileSync("supabase/migrations/20261002005023_direct_recording_integration.sql", "utf8"));
  const retry = stripTx(fs.readFileSync("supabase/migrations/20261002011737_direct_recording_monotonic_retry.sql", "utf8"));
  const link = stripTx(fs.readFileSync("supabase/migrations/20261002013151_direct_recording_link_repair.sql", "utf8"));
  const library = stripTx(fs.readFileSync("supabase/migrations/20261002015000_direct_recording_library.sql", "utf8"));
  const libraryRollback = stripTx(fs.readFileSync("supabase/rollbacks/20261002015000_direct_recording_library.sql", "utf8"));
  await pg.query("begin");
  try {
    await pg.query(directCalls);
    await pg.query(recording);
    await pg.query(retry);
    await pg.query(link);
    await pg.query(library);
    await pg.query(library);
    await pg.query("insert into public.organizations(id,name) values ($1,'Sandra direct library test') on conflict do nothing", [ORG]);
    for (const id of [USER, OTHER_USER]) await pg.query("insert into auth.users(id) values ($1) on conflict do nothing", [id]);
    for (const [user, role] of [[USER, "owner"], [OTHER_USER, "member"]] as const) {
      await pg.query(
        "insert into public.memberships(user_id,org_id,role) values ($1,$2,$3) on conflict (user_id,org_id) do nothing",
        [user, ORG, role],
      );
      await pg.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [ORG, user]);
      await pg.query("update public.memberships set acquisitions_enabled=true, access_status='active', deletion_prepared_at=null, access_expires_at=null where user_id=$1 and org_id=$2", [user, ORG]);
      await pg.query("select set_config('my_leads.designation_update', '', true)");
    }
    const callId = "00000000-0000-4000-8000-000000015011";
    const activityId = "00000000-0000-4000-8000-000000015012";
    const propertyId = "00000000-0000-4000-8000-000000015013";
    const contactId = "00000000-0000-4000-8000-000000015014";
    const ledgerId = "00000000-0000-4000-8000-000000015015";
    await pg.query("insert into public.contacts(id,org_id,first_name) values ($1,$2,'Library seller')", [contactId, ORG]);
    await pg.query("insert into public.properties(id,org_id,address,state,homeowner_contact_id) values ($1,$2,'15 Direct Library Way','MO',$3)", [propertyId, ORG, contactId]);
    await pg.query(
      "insert into public.direct_calls(id,org_id,operator_user_id,destination_e164,caller_id_e164,status,seller_leg_id,client_request_id) values ($1,$2,$3,'+15550000011','+15550000012','ended','seller-library',$4)",
      [callId, ORG, USER, "00000000-0000-4000-8000-000000015016"],
    );
    await pg.query(
      "insert into public.call_activities(id,org_id,property_id,contact_id,jitter_attempt_id,provider,operator_user_id,direct_call_id) values ($1,$2,$3,$4,$5,'sandra_softphone',$6,$7)",
      [activityId, ORG, propertyId, contactId, "direct-library-test", USER, callId],
    );
    await pg.query(
      "insert into public.direct_call_recordings(id,direct_call_id,provider_recording_id,provider_call_control_id,status,storage_bucket,storage_path,duration_seconds) values ($1,$2,'telnyx-library-recording','seller-library','available','sandra-direct-recordings',$3,73)",
      [ledgerId, callId, `${ORG}/${callId}/telnyx-library-recording.wav`],
    );
    await pg.query(
      "insert into public.call_recordings(call_activity_id,status,provider_recording_id,provider_call_control_id,storage_bucket,storage_path,duration_seconds) values ($1,'available','telnyx-library-recording','seller-library','sandra-direct-recordings',$2,73)",
      [activityId, `${ORG}/${callId}/telnyx-library-recording.wav`],
    );

    const source = (await pg.query("select public.fn_recording_library_sources($1,'owner') as value", [USER])).rows[0].value as Array<Record<string, unknown>>;
    const direct = source.find(row => row.id === activityId);
    expect(direct).toMatchObject({ id: activityId, source: "sandra_direct", directCallId: callId, actorId: USER });
    expect((direct?.files as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: `recording:${(await pg.query("select id from public.call_recordings where call_activity_id=$1", [activityId])).rows[0].id}`,
      source: "sandra_direct",
      storageBucket: "sandra-direct-recordings",
      storagePath: `${ORG}/${callId}/telnyx-library-recording.wav`,
    });
    expect((await pg.query("select public.fn_recording_library_sources($1,'mine') as value", [OTHER_USER])).rows[0].value).toEqual([]);

    const audio = JSON.stringify([direct]);
    const fileId = (direct?.files as Array<Record<string, unknown>>)[0].id;
    const file = (await pg.query("select public.fn_recording_library_file($1,'owner',$2,$3::jsonb) as value", [USER, fileId, audio])).rows[0].value as Record<string, unknown>;
    expect(file).toMatchObject({ callId: `call:${activityId}`, source: "sandra_softphone", file: { source: "sandra_direct", storagePath: `${ORG}/${callId}/telnyx-library-recording.wav` } });
    expect((await pg.query("select public.fn_recording_library_file($1,'mine',$2,$3::jsonb) as value", [OTHER_USER, fileId, "[]"])).rows[0].value).toBeNull();

    const search = (await pg.query("select public.fn_recording_library_search($1,'owner',$2::jsonb,$3::jsonb) as value", [USER, JSON.stringify({ status: "available" }), audio])).rows[0].value as Record<string, unknown>;
    expect((search.rows as Array<Record<string, unknown>>).some(row => (row.files as Array<Record<string, unknown>>).some(fileRow => fileRow.source === "sandra_direct" && fileRow.status === "available"))).toBe(true);
    await pg.query(libraryRollback);
    const restored = (await pg.query("select public.fn_recording_library_sources($1,'owner') as value", [USER])).rows[0].value as Array<Record<string, unknown>>;
    expect(restored.find(row => row.id === activityId)?.source).toBeUndefined();
  } finally {
    await pg.query("rollback").catch(() => undefined);
    await pg.end();
  }
});
