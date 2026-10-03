import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const migration = readFileSync(new URL("./20261003130001_slack_lead_unfurl_foundation.sql", import.meta.url), "utf8");
const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it("Slack installation, approval, nonce, receipt, claim, fencing, revocation, and cleanup contracts hold", async () => {
  if (!dbUrl) throw new Error("Missing TEST_SUPABASE_DB_URL");
  const parsed = new URL(dbUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "54329") throw new Error("Slack foundation integration requires local Postgres at 127.0.0.1:54329");
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const org = randomUUID();
  const user = randomUUID();
  const member = randomUUID();
  const team = `T_${randomUUID().slice(0, 8)}`;
  const app = `A_${randomUUID().slice(0, 8)}`;
  try {
    await db.query("begin");
    await db.query(migration);
    const privilege = await db.query("select has_function_privilege('service_role', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute') as service_allowed, has_function_privilege('authenticated', 'public.get_slack_preview_attempt_facts(uuid,uuid)', 'execute') as authenticated_allowed, has_function_privilege('service_role', 'public.guard_slack_unfurl_dispatch(uuid,uuid,uuid,integer,uuid,text,text)', 'execute') as guard_allowed, has_function_privilege('authenticated', 'public.guard_slack_unfurl_dispatch(uuid,uuid,uuid,integer,uuid,text,text)', 'execute') as guard_authenticated_allowed, has_function_privilege('service_role', 'public.revoke_slack_installation_generation(text,text,uuid,integer,text)', 'execute') as generation_revoke_allowed, has_function_privilege('authenticated', 'public.revoke_slack_installation_generation(text,text,uuid,integer,text)', 'execute') as generation_revoke_authenticated_allowed");
    expect(privilege.rows[0].service_allowed).toBe(true);
    expect(privilege.rows[0]).toMatchObject({ authenticated_allowed: false, guard_allowed: true, guard_authenticated_allowed: false, generation_revoke_allowed: true, generation_revoke_authenticated_allowed: false });
    const tablePrivileges = await db.query("select has_table_privilege('service_role','public.slack_installations','select') as installation_read, has_table_privilege('service_role','public.slack_account_links','select') as link_read, has_table_privilege('service_role','public.slack_channel_approvals','select') as approval_read, has_table_privilege('service_role','public.memberships','select') as membership_read, has_table_privilege('service_role','public.slack_unfurl_job_urls','update') as url_update, has_table_privilege('authenticated','public.slack_installations','select') as authenticated_read");
    expect(tablePrivileges.rows[0]).toMatchObject({ installation_read: true, link_read: true, approval_read: true, membership_read: true, url_update: true, authenticated_read: false });
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into auth.users(id) values($1)", [member]);
    await db.query("insert into public.organizations(id,name) values($1,'slack db test')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role) values($1,$2,'owner')", [user, org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values($1,$2,'member','active')", [member, org]);

    const nonce = randomUUID();
    expect((await db.query("select public.create_slack_oauth_nonce($1,$2,$3,null,now()+interval '10 minutes')", [nonce, user, org])).rowCount).toBe(1);
    expect((await db.query("select public.consume_slack_oauth_nonce($1,$2,$3) as ok", [nonce, user, org])).rows[0].ok).toBe(true);
    expect((await db.query("select public.consume_slack_oauth_nonce($1,$2,$3) as ok", [nonce, user, org])).rows[0].ok).toBe(false);

    const install = (await db.query("select * from public.upsert_slack_installation($1,$2,$3,'DB test','B_DB','xoxb-token',array['links:read','links:write','channels:read','groups:read','users:read'],$4,'db-key')", [org, team, app, user])).rows[0];
    expect(install.installation_version).toBe(1);
    const accountLink = (await db.query("select public.upsert_slack_account_link($1,$2,$3,'U_DB') as id", [install.installation_id, org, user])).rows[0].id;
    expect(accountLink).toBeTruthy();
    expect((await db.query("select * from public.upsert_slack_installation($1,$2,$3,'DB test','B_DB','xoxb-token-2',array['links:read'],$4,'db-key')", [org, team, app, user])).rows[0].installation_version).toBe(1);
    await db.query("savepoint approval_rejection");
    await expect(db.query("select public.approve_slack_channel($1,$2,'C_DB',$3,false)", [install.installation_id, org, user])).rejects.toThrow("SHARING_POLICY_ACK_REQUIRED");
    await db.query("rollback to savepoint approval_rejection");
    await db.query("savepoint member_rejection");
    await expect(db.query("select public.approve_slack_channel($1,$2,'C_MEMBER',$3,true)", [install.installation_id, org, member])).rejects.toThrow("APPROVER_NOT_ACTIVE");
    await db.query("rollback to savepoint member_rejection");
    await db.query("savepoint admin_rejection");
    await db.query("alter table public.memberships drop constraint memberships_role_check");
    await db.query("update public.memberships set role='admin' where user_id=$1 and org_id=$2", [member, org]);
    await expect(db.query("select public.approve_slack_channel($1,$2,'C_ADMIN',$3,true)", [install.installation_id, org, member])).rejects.toThrow("APPROVER_NOT_ACTIVE");
    await db.query("rollback to savepoint admin_rejection");
    const approval = await db.query("select public.approve_slack_channel($1,$2,'C_DB',$3,true) as id", [install.installation_id, org, user]);
    expect(approval.rows[0].id).toBeTruthy();

    const event = randomUUID();
    const inserted = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','1.1','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, event, org, install.installation_id, 1])).rows[0];
    expect(inserted.job_id).toBeTruthy();
    expect((await db.query("select installation_version from public.slack_unfurl_jobs where id=$1", [inserted.job_id])).rows[0].installation_version).toBe(1);
    await db.query("set role service_role");
    expect((await db.query("select count(*)::int as count from public.slack_installations where id=$1", [install.installation_id])).rows[0].count).toBe(1);
    await db.query("update public.slack_unfurl_job_urls set lookup_status='queued' where job_id=$1", [inserted.job_id]);
    await db.query("reset role");
    const duplicate = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','1.1','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, event, org, install.installation_id, 1])).rows[0];
    expect(duplicate.duplicate).toBe(true);
    const claimed = (await db.query("select * from public.claim_slack_unfurl_jobs(now(),$1,90,5)", [randomUUID()])).rows[0];
    expect(claimed.attempts).toBe(1);
    expect((await db.query("select public.finish_slack_unfurl_job($1,$2,'succeeded',null) as ok", [claimed.id, randomUUID()])).rows[0].ok).toBe(false);
    expect((await db.query("select public.finish_slack_unfurl_job($1,$2,'succeeded',null) as ok", [claimed.id, claimed.claim_token])).rows[0].ok).toBe(true);
    const releaseEvent = randomUUID();
    const releaseJob = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','1.15','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, releaseEvent, org, install.installation_id, 1])).rows[0];
    const releaseToken = randomUUID();
    await db.query("update public.slack_unfurl_jobs set attempts=1,status='processing',claim_token=$2,lease_expires_at=now()+interval '1 minute' where id=$1", [releaseJob.job_id, releaseToken]);
    expect((await db.query("select public.release_slack_unfurl_job_claim($1,$2) as ok", [releaseJob.job_id, releaseToken])).rows[0].ok).toBe(true);
    expect((await db.query("select status,attempts from public.slack_unfurl_jobs where id=$1", [releaseJob.job_id])).rows[0]).toMatchObject({ status: "queued", attempts: 0 });
    const cancelEvent = randomUUID();
    const cancelJob = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','1.2','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, cancelEvent, org, install.installation_id, 1])).rows[0];
    await db.query("select public.revoke_slack_installation($1,$2,'tokens_revoked')", [team, app]);
    expect((await db.query("select status from public.slack_unfurl_jobs where id=$1", [cancelJob.job_id])).rows[0].status).toBe("cancelled");
    expect((await db.query("select status from public.slack_event_receipts where event_id=$1", [cancelEvent])).rows[0].status).toBe("revoked");
    expect((await db.query("select status from public.slack_account_links where id=$1", [accountLink])).rows[0].status).toBe("revoked");
    await db.query("savepoint stale_enqueue_rejection");
    await expect(db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','2.2','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, randomUUID(), org, install.installation_id, 1])).rejects.toThrow("INSTALLATION_NOT_ACTIVE");
    await db.query("rollback to savepoint stale_enqueue_rejection");
    expect((await db.query("select * from public.upsert_slack_installation($1,$2,$3,'DB test','B_DB','xoxb-token-3',array[]::text[],$4,'db-key')", [org, team, app, user])).rows[0].installation_version).toBe(2);
    const reinstalled = (await db.query("select id, installation_version from public.slack_installations where org_id=$1 and team_id=$2 and app_id=$3", [org, team, app])).rows[0];
    await db.query("savepoint version_mismatch_rejection");
    await expect(db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','3.2','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, randomUUID(), org, reinstalled.id, 1])).rejects.toThrow("INSTALLATION_VERSION_MISMATCH");
    await db.query("rollback to savepoint version_mismatch_rejection");
    const secondEvent = randomUUID();
    const secondJob = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','3.3','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, secondEvent, org, reinstalled.id, 2])).rows[0];
    expect((await db.query("select installation_version from public.slack_unfurl_jobs where id=$1", [secondJob.job_id])).rows[0].installation_version).toBe(2);
    await db.query("update public.slack_unfurl_jobs set attempts=1,max_attempts=1,status='processing',lease_expires_at=now()-interval '1 second',claim_token=$2 where id=$1", [secondJob.job_id, randomUUID()]);
    expect((await db.query("select * from public.claim_slack_unfurl_jobs(now(),$1,90,5)", [randomUUID()])).rows).toHaveLength(0);
    expect((await db.query("select status from public.slack_unfurl_jobs where id=$1", [secondJob.job_id])).rows[0].status).toBe("failed");

    const rescheduleEvent = randomUUID();
    const rescheduleJob = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','4.4','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, rescheduleEvent, org, reinstalled.id, 2])).rows[0];
    const rescheduleToken = randomUUID();
    await db.query("update public.slack_unfurl_jobs set attempts=1,max_attempts=1,status='processing',claim_token=$2,lease_expires_at=now()+interval '1 minute' where id=$1", [rescheduleJob.job_id, rescheduleToken]);
    expect((await db.query("select public.reschedule_slack_unfurl_job($1,$2,now()+interval '15 seconds','max_attempts') as ok", [rescheduleJob.job_id, rescheduleToken])).rows[0].ok).toBe(true);
    expect((await db.query("select status from public.slack_unfurl_jobs where id=$1", [rescheduleJob.job_id])).rows[0].status).toBe("failed");
    expect((await db.query("select status from public.slack_event_receipts where id=(select receipt_id from public.slack_unfurl_jobs where id=$1)", [rescheduleJob.job_id])).rows[0].status).toBe("failed");

    // A worker handling a v1 request may receive invalid_auth after v2 has
    // reconnected. The stale generation is a no-op; the matching generation
    // revokes only v2's links, approvals, jobs, and receipt.
    await db.query("select public.upsert_slack_account_link($1,$2,$3,'U_DB')", [reinstalled.id, org, user]);
    await db.query("select public.approve_slack_channel($1,$2,'C_DB',$3,true)", [reinstalled.id, org, user]);
    const generationEvent = randomUUID();
    const generationJob = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,$6,'C_DB','4.5','U_DB',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, generationEvent, org, reinstalled.id, 2])).rows[0];
    expect((await db.query("select public.revoke_slack_installation_generation($1,$2,$3,1,'invalid_auth') as count", [team, app, reinstalled.id])).rows[0].count).toBe(0);
    expect((await db.query("select status from public.slack_installations where id=$1", [reinstalled.id])).rows[0].status).toBe("active");
    expect((await db.query("select status from public.slack_unfurl_jobs where id=$1", [generationJob.job_id])).rows[0].status).toBe("queued");
    expect((await db.query("select public.revoke_slack_installation_generation($1,$2,$3,2,'invalid_auth') as count", [team, app, reinstalled.id])).rows[0].count).toBe(1);
    expect((await db.query("select status from public.slack_installations where id=$1", [reinstalled.id])).rows[0].status).toBe("revoked");
    expect((await db.query("select status from public.slack_account_links where installation_id=$1", [reinstalled.id])).rows[0].status).toBe("revoked");
    expect((await db.query("select status from public.slack_channel_approvals where installation_id=$1 and channel_id='C_DB'", [reinstalled.id])).rows[0].status).toBe("revoked");
    expect((await db.query("select status from public.slack_unfurl_jobs where id=$1", [generationJob.job_id])).rows[0].status).toBe("cancelled");
    expect((await db.query("select status from public.slack_event_receipts where id=(select receipt_id from public.slack_unfurl_jobs where id=$1)", [generationJob.job_id])).rows[0].status).toBe("revoked");

    // The lifecycle receipt is unique across reconnects. Replaying an old
    // event after a fresh installation must not revoke the new generation.
    const lifecycleEvent = randomUUID();
    expect((await db.query("select public.process_slack_lifecycle_event($1,$2,$3,'app_uninstalled',now(),null,array[]::text[],'installation') as ok", [team, app, lifecycleEvent])).rows[0].ok).toBe(true);
    expect((await db.query("select status from public.slack_installations where id=$1", [reinstalled.id])).rows[0].status).toBe("revoked");
    const v3 = (await db.query("select * from public.upsert_slack_installation($1,$2,$3,'DB test','B_DB','xoxb-token-4',array[]::text[],$4,'db-key')", [org, team, app, user])).rows[0];
    expect(v3.installation_version).toBe(3);
    expect((await db.query("select public.process_slack_lifecycle_event($1,$2,$3,'app_uninstalled',now(),null,array[]::text[],'installation') as ok", [team, app, lifecycleEvent])).rows[0].ok).toBe(false);
    expect((await db.query("select status from public.slack_installations where id=$1", [v3.installation_id])).rows[0].status).toBe("active");
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
});
