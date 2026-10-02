import fs from "node:fs";
import { Client } from "pg";
import { expect, it } from "vitest";
import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const ORG = "00000000-0000-0000-0000-000000020001";
const USER = "00000000-0000-4000-8000-000000020002";
const REQUEST = "00000000-0000-4000-8000-000000020003";
const SESSION = "00000000-0000-4000-8000-000000020004";
const BROWSER = "browser-watchdog-leg";
const stripTx = (sql: string) => sql.replace(/^\s*(begin|commit);\s*$/gim, "");
const sql = (name: string) => stripTx(fs.readFileSync(`supabase/migrations/${name}`, "utf8"));

it("arms, renews, fences, and claims a browser lease with database-clock timing", async () => {
  const pg = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres") });
  await pg.connect();
  await pg.query("begin");
  try {
    await pg.query(sql("20261001200000_direct_calls.sql"));
    await pg.query(sql("20261001210000_direct_call_duration_dispatch.sql"));
    await pg.query(sql("20261001220000_direct_call_prepare_ownership.sql"));
    await pg.query(sql("20261002020000_direct_browser_watchdog.sql"));
    await pg.query(sql("20261002020000_direct_browser_watchdog.sql"));
    const privileges = (await pg.query(`select
      has_function_privilege('service_role','public.direct_watchdog_heartbeat(text)','execute') as service_can_heartbeat,
      has_function_privilege('authenticated','public.direct_watchdog_heartbeat(text)','execute') as user_can_heartbeat,
      has_function_privilege('service_role','public.direct_call_watchdog_arm(uuid,uuid,uuid)','execute') as service_can_arm,
      has_function_privilege('authenticated','public.direct_call_watchdog_arm(uuid,uuid,uuid)','execute') as user_can_arm,
      has_function_privilege('service_role','public.direct_call_watchdog_claim_expired(integer)','execute') as service_can_claim,
      has_function_privilege('authenticated','public.direct_call_watchdog_claim_expired(integer)','execute') as user_can_claim`)).rows[0];
    expect(privileges).toEqual({ service_can_heartbeat: true, user_can_heartbeat: false, service_can_arm: true, user_can_arm: false, service_can_claim: true, user_can_claim: false });
    await pg.query("insert into public.organizations(id,name) values ($1,'watchdog test') on conflict do nothing", [ORG]);
    await pg.query("insert into auth.users(id) values ($1) on conflict do nothing", [USER]);
    await pg.query("select public.direct_watchdog_heartbeat('integration-watchdog')");
    const begun = (await pg.query(
      "select * from public.direct_call_begin($1,$2,null,null,'','+15550002222',$3,180,null,$4)",
      [ORG, USER, REQUEST, SESSION],
    )).rows[0];
    expect(begun).toMatchObject({ outcome: "created" });
    const callId = begun.call_id as string;
    expect((await pg.query("select browser_watchdog_expires_at is null as unarmed from public.direct_calls where id=$1", [callId])).rows[0].unarmed).toBe(true);
    const armed = (await pg.query("select public.direct_call_watchdog_arm($1,$2,$3)", [callId, USER, SESSION])).rows[0].direct_call_watchdog_arm;
    expect(armed).toBe(true);
    await pg.query("update public.direct_calls set browser_leg_id=$1 where id=$2", [BROWSER, callId]);
    const attached = (await pg.query("select public.direct_call_watchdog_attach($1,$2,$3,$4)", [callId, USER, BROWSER, SESSION])).rows[0].direct_call_watchdog_attach;
    expect(attached).toBe(true);
    const renewed = (await pg.query("select public.direct_call_watchdog_renew($1,$2,$3,$4)", [callId, USER, BROWSER, SESSION])).rows[0].direct_call_watchdog_renew;
    expect(renewed).toBe(true);
    const lease = (await pg.query("select browser_watchdog_expires_at > now() as fresh, browser_watchdog_claimed_at from public.direct_calls where id=$1", [callId])).rows[0];
    expect(lease).toMatchObject({ fresh: true, browser_watchdog_claimed_at: null });
    const disconnected = (await pg.query("select public.direct_call_watchdog_disconnect($1,$2,$3,$4,true)", [callId, USER, BROWSER, SESSION])).rows[0].direct_call_watchdog_disconnect;
    expect(disconnected).toBe(true);
    const shortened = (await pg.query("select browser_watchdog_expires_at <= now() + interval '6 seconds' as within_grace from public.direct_calls where id=$1", [callId])).rows[0].within_grace;
    expect(shortened).toBe(true);
    await pg.query("update public.direct_calls set browser_watchdog_expires_at=now()-interval '1 second' where id=$1", [callId]);
    const claimed = (await pg.query("select * from public.direct_call_watchdog_claim_expired(5)")).rows;
    expect(claimed).toEqual([{ call_id: callId, operator_user_id: USER, browser_watchdog_session_id: SESSION }]);
    expect((await pg.query("select browser_watchdog_claimed_at is not null as claimed from public.direct_calls where id=$1", [callId])).rows[0].claimed).toBe(true);
    await pg.query("update public.direct_calls set status='ended' where id=$1", [callId]);
    await pg.query("delete from public.direct_call_cleanups where direct_call_id=$1", [callId]);
    await pg.query("delete from public.direct_watchdog_liveness");
    const refused = (await pg.query(
      "select * from public.direct_call_begin($1,$2,null,null,'','+15550002222',$3,180,null,$4)",
      [ORG, USER, "00000000-0000-4000-8000-000000020006", "00000000-0000-4000-8000-000000020007"],
    )).rows[0];
    expect(refused).toEqual({ outcome: "watchdog_unavailable", call_id: null });
  } finally {
    await pg.query("rollback");
    await pg.end();
  }
});
