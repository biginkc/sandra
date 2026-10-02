import fs from "node:fs";

import { Client } from "pg";
import { expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const ORG = "00000000-0000-0000-0000-000000000bbb";
const USER = "00000000-0000-4000-8000-000000016001";
const OTHER_USER = "00000000-0000-4000-8000-000000016002";
const CALL = "00000000-0000-4000-8000-000000016011";
const ACTIVITY = CALL;
const REQUEST = "00000000-0000-4000-8000-000000016012";
const FORGED_ACTIVITY = "00000000-0000-4000-8000-000000016013";
const stripTx = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");

it("precreates direct training activity with service auth and permits only immutable authenticated wrap-up", async () => {
  const pg = new Client({
    connectionString: requireLoopbackPostgresUrl(
      process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
    ),
  });
  await pg.connect();
  await pg.query("begin");
  try {
    // Keep these additive schema prerequisites inside the test transaction so
    // the loopback database is restored for the next integration file.
    await pg.query(stripTx(fs.readFileSync("supabase/migrations/20261001200000_direct_calls.sql", "utf8")));
    await pg.query(stripTx(fs.readFileSync("supabase/migrations/20261002005023_direct_recording_integration.sql", "utf8")));
    const schema = await pg.query<{ has_purpose: boolean; has_direct_id: boolean }>(
      `select
         exists (select 1 from information_schema.columns where table_schema='public' and table_name='call_activities' and column_name='call_purpose') as has_purpose,
         exists (select 1 from information_schema.columns where table_schema='public' and table_name='call_activities' and column_name='direct_call_id') as has_direct_id`,
    );
    expect(schema.rows[0]).toEqual({ has_purpose: true, has_direct_id: true });

    await pg.query("insert into public.organizations(id,name) values ($1,'Direct training wrap-up test') on conflict do nothing", [ORG]);
    for (const id of [USER, OTHER_USER]) await pg.query("insert into auth.users(id) values ($1) on conflict do nothing", [id]);
    await pg.query(
      "insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner') on conflict (user_id,org_id) do nothing",
      [USER, ORG],
    );
    await pg.query(
      "insert into public.memberships(user_id,org_id,role) values ($1,$2,'member') on conflict (user_id,org_id) do nothing",
      [OTHER_USER, ORG],
    );
    for (const user of [USER, OTHER_USER]) {
      await pg.query("select set_config('my_leads.designation_update', format(':%s:%s', $1::text, $2::text), true)", [ORG, user]);
      await pg.query("update public.memberships set acquisitions_enabled=true, access_status='active' where org_id=$1 and user_id=$2", [ORG, user]);
      await pg.query("select set_config('my_leads.designation_update', '', true)");
    }

    await pg.query(
      `insert into public.direct_calls
        (id,org_id,operator_user_id,destination_e164,caller_id_e164,status,client_request_id)
       values ($1,$2,$3,'+15550007777','+15550002222','browser_connecting',$4)`,
      [CALL, ORG, USER, REQUEST],
    );

    // This is the service-role write performed by startDirectCall before the
    // browser receives a capability. It must carry the immutable training
    // purpose and direct-call identity.
    await pg.query("set local role service_role");
    await pg.query("select set_config('request.jwt.claim.role','service_role',true)");
    await pg.query(
      `insert into public.call_activities
        (id,org_id,property_id,contact_id,jitter_attempt_id,provider,operator_user_id,
         direct_call_id,phone_e164,call_purpose,direction,notes,started_at)
       values ($1,$2,null,null,$3,'sandra_softphone',$4,$5,'+15550007777',
         'internal_training','outbound','Internal training — AI homeowner','2026-10-01T12:00:00Z')`,
      [ACTIVITY, ORG, `sandra-${CALL}`, USER, CALL],
    );
    const precreated = (await pg.query(
      "select id,direct_call_id,call_purpose,operator_user_id,property_id,contact_id from public.call_activities where id=$1",
      [ACTIVITY],
    )).rows[0];
    expect(precreated).toMatchObject({
      id: ACTIVITY,
      direct_call_id: CALL,
      call_purpose: "internal_training",
      operator_user_id: USER,
      property_id: null,
      contact_id: null,
    });

    // The authenticated cookie client used by completeSoftphoneCall updates
    // this server-owned row; changing purpose or identity remains forbidden.
    await pg.query("set local role authenticated");
    await pg.query("select set_config('request.jwt.claim.role','authenticated',true)");
    await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [USER]);
    await pg.query(
      "update public.call_activities set ended_at='2026-10-01T12:01:00Z',duration_seconds=60,outcome='connected_human',notes='wrapped',wrap_token=$1 where id=$2",
      ["00000000-0000-4000-8000-000000016014", ACTIVITY],
    );
    const wrapped = (await pg.query("select call_purpose,ended_at,duration_seconds from public.call_activities where id=$1", [ACTIVITY])).rows[0];
    expect(wrapped).toMatchObject({ call_purpose: "internal_training", duration_seconds: 60 });
    expect(wrapped.ended_at).not.toBeNull();

    await expect(
      pg.query(
        `insert into public.call_activities
          (id,org_id,property_id,contact_id,jitter_attempt_id,provider,operator_user_id,phone_e164,call_purpose,direction)
         values ($1,$2,null,null,$3,'sandra_softphone',$4,'+15550007777','internal_training','outbound')`,
        [FORGED_ACTIVITY, ORG, OTHER_USER, OTHER_USER],
      ),
    ).rejects.toMatchObject({ code: "42501" });
  } finally {
    await pg.query("rollback");
    await pg.end();
  }
});
