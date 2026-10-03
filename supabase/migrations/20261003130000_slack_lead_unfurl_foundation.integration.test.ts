import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const migration = readFileSync(new URL("./20261003130000_slack_lead_unfurl_foundation.sql", import.meta.url), "utf8");
const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it("Slack installation, approval, nonce, receipt, claim, fencing, revocation, and cleanup contracts hold", async () => {
  if (!dbUrl) throw new Error("Missing TEST_SUPABASE_DB_URL");
  const parsed = new URL(dbUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "54329") throw new Error("Slack foundation integration requires local Postgres at 127.0.0.1:54329");
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const org = randomUUID();
  const user = randomUUID();
  const team = `T_${randomUUID().slice(0, 8)}`;
  const app = `A_${randomUUID().slice(0, 8)}`;
  try {
    await db.query("begin");
    await db.query(migration);
    const privilege = await db.query("select has_function_privilege('service_role', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute') as service_allowed, has_function_privilege('authenticated', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute') as authenticated_allowed");
    expect(privilege.rows[0].service_allowed).toBe(true);
    expect(privilege.rows[0].authenticated_allowed).toBe(false);
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.organizations(id,name) values($1,'slack db test')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values($1,$2,'owner')", [user, org]);

    const nonce = randomUUID();
    expect((await db.query("select public.create_slack_oauth_nonce($1,$2,$3,null,now()+interval '10 minutes')", [nonce, user, org])).rowCount).toBe(1);
    expect((await db.query("select public.consume_slack_oauth_nonce($1,$2,$3) as ok", [nonce, user, org])).rows[0].ok).toBe(true);
    expect((await db.query("select public.consume_slack_oauth_nonce($1,$2,$3) as ok", [nonce, user, org])).rows[0].ok).toBe(false);

    const install = (await db.query("select * from public.upsert_slack_installation($1,$2,$3,'DB test','B_DB','xoxb-token',array['links:read','links:write','channels:read','groups:read','users:read'],$4,'db-key')", [org, team, app, user])).rows[0];
    expect(install.installation_version).toBe(1);
    expect((await db.query("select * from public.upsert_slack_installation($1,$2,$3,'DB test','B_DB','xoxb-token-2',array['links:read'],$4,'db-key')", [org, team, app, user])).rows[0].installation_version).toBe(1);
    await db.query("savepoint approval_rejection");
    await expect(db.query("select public.approve_slack_channel($1,$2,'C_DB',$3,false)", [install.installation_id, org, user])).rejects.toThrow("SHARING_POLICY_ACK_REQUIRED");
    await db.query("rollback to savepoint approval_rejection");
    await db.query("savepoint member_rejection");
    await db.query("update public.memberships set role='member' where user_id=$1 and org_id=$2", [user, org]);
    await expect(db.query("select public.approve_slack_channel($1,$2,'C_MEMBER',$3,true)", [install.installation_id, org, user])).rejects.toThrow("APPROVER_NOT_ACTIVE");
    await db.query("rollback to savepoint member_rejection");
    const approval = await db.query("select public.approve_slack_channel($1,$2,'C_DB',$3,true) as id", [install.installation_id, org, user]);
    expect(approval.rows[0].id).toBeTruthy();

    const event = randomUUID();
    const inserted = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,'C_DB','1.1','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, event, org, install.installation_id])).rows[0];
    expect(inserted.job_id).toBeTruthy();
    const duplicate = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,'C_DB','1.1','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, event, org, install.installation_id])).rows[0];
    expect(duplicate.duplicate).toBe(true);
    const claimed = (await db.query("select * from public.claim_slack_unfurl_jobs(now(),$1,90,5)", [randomUUID()])).rows[0];
    expect(claimed.attempts).toBe(1);
    expect((await db.query("select public.finish_slack_unfurl_job($1,$2,'succeeded',null) as ok", [claimed.id, randomUUID()])).rows[0].ok).toBe(false);
    expect((await db.query("select public.finish_slack_unfurl_job($1,$2,'succeeded',null) as ok", [claimed.id, claimed.claim_token])).rows[0].ok).toBe(true);
    await db.query("select public.revoke_slack_installation($1,$2,'tokens_revoked')", [team, app]);
    expect((await db.query("select * from public.upsert_slack_installation($1,$2,$3,'DB test','B_DB','xoxb-token-3',array[]::text[],$4,'db-key')", [org, team, app, user])).rows[0].installation_version).toBe(2);
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
});
