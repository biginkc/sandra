import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const foundation = readFileSync(new URL("./20261003130001_slack_lead_unfurl_foundation.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("./20261003160000_slack_workspace_preview_policy.sql", import.meta.url), "utf8");
const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? loadTestEnv().TEST_SUPABASE_DB_URL;

it("workspace policy allows verified internal channels and fences disable, tombstone, and re-enable revisions", async () => {
  if (!dbUrl) throw new Error("Missing TEST_SUPABASE_DB_URL");
  const parsed = new URL(dbUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "54329") throw new Error("Slack workspace policy integration requires local Postgres at 127.0.0.1:54329");
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const org = randomUUID();
  const user = randomUUID();
  const team = `T_${randomUUID().slice(0, 8)}`;
  const app = `A_${randomUUID().slice(0, 8)}`;
  try {
    await db.query("begin");
    await db.query(foundation);
    await db.query(migration);
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.organizations(id,name) values($1,'policy test')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values($1,$2,'owner','active')", [user, org]);
    const installation = (await db.query("select * from public.upsert_slack_installation($1,$2,$3,'Policy test','B_POLICY','xoxb-token',array['links:read','links:write','channels:read','groups:read','users:read'],$4,'policy-key')", [org, team, app, user])).rows[0];
    expect((await db.query("select mode from public.slack_preview_policies where installation_id=$1", [installation.installation_id])).rows[0].mode).toBe("legacy");
    const enabled = (await db.query("select * from public.set_slack_preview_policy($1,$2,$3,true)", [installation.installation_id, org, user])).rows[0];
    expect(enabled.mode).toBe("eligible_internal_channels");
    const repeatedEnable = (await db.query("select * from public.set_slack_preview_policy($1,$2,$3,true)", [installation.installation_id, org, user])).rows[0];
    expect(Number(repeatedEnable.policy_revision)).toBe(Number(enabled.policy_revision));
    const staleEvent = randomUUID();
    const stale = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',$4,$5,$6,1,'C_AUTO','1.0','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, staleEvent, new Date(Date.now() - 120_000).toISOString(), org, installation.installation_id])).rows[0];
    expect(stale.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where event_id=$1", [staleEvent])).rows[0].denial_code).toBe("event_before_policy");
    const missingTimestampEvent = randomUUID();
    const missingTimestamp = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',null,$4,$5,1,'C_AUTO','1.0-missing-time','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, missingTimestampEvent, org, installation.installation_id])).rows[0];
    expect(missingTimestamp.accepted).toBe(false);
    expect(missingTimestamp.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where event_id=$1", [missingTimestampEvent])).rows[0].denial_code).toBe("event_before_policy");
    await db.query("update public.slack_preview_policies set acknowledged_at=null where installation_id=$1", [installation.installation_id]);
    const missingAcknowledgementEvent = randomUUID();
    const missingAcknowledgement = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_AUTO','1.0-missing-ack','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, missingAcknowledgementEvent, org, installation.installation_id])).rows[0];
    expect(missingAcknowledgement.accepted).toBe(false);
    expect(missingAcknowledgement.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where event_id=$1", [missingAcknowledgementEvent])).rows[0].denial_code).toBe("policy_not_acknowledged");
    await db.query("update public.slack_preview_policies set acknowledged_at=now() where installation_id=$1", [installation.installation_id]);
    const event = randomUUID();
    const job = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_AUTO','1.1','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, event, org, installation.installation_id])).rows[0];
    expect(job.job_id).toBeTruthy();
    const revision = (await db.query("select policy_revision from public.slack_unfurl_jobs where id=$1", [job.job_id])).rows[0].policy_revision;
    expect(revision).toBe(enabled.policy_revision);
    const disabled = (await db.query("select * from public.set_slack_preview_policy($1,$2,$3,false)", [installation.installation_id, org, user])).rows[0];
    expect(disabled.mode).toBe("disabled");
    expect((await db.query("select status from public.slack_unfurl_jobs where id=$1", [job.job_id])).rows[0].status).toBe("cancelled");
    const disabledEvent = randomUUID();
    const denied = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_AUTO','1.2','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, disabledEvent, org, installation.installation_id])).rows[0];
    expect(denied.accepted).toBe(false);
    expect(denied.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where event_id=$1", [disabledEvent])).rows[0].denial_code).toBe("previews_disabled");
    const reenabled = (await db.query("select * from public.set_slack_preview_policy($1,$2,$3,true)", [installation.installation_id, org, user])).rows[0];
    expect(Number(reenabled.policy_revision)).toBeGreaterThan(Number(disabled.policy_revision));
    const lifecycle = randomUUID();
    await db.query("select public.process_slack_lifecycle_event($1,$2,$3,'channel_shared',now(),'C_TOMBSTONE',array[]::text[],'channel')", [team, app, lifecycle]);
    expect((await db.query("select count(*)::int as count from public.slack_channel_denials where installation_id=$1 and channel_id='C_TOMBSTONE'", [installation.installation_id])).rows[0].count).toBe(1);
    const tombstoneEvent = randomUUID();
    const tombstone = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_TOMBSTONE','1.3','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, tombstoneEvent, org, installation.installation_id])).rows[0];
    expect(tombstone.accepted).toBe(false);
    expect(tombstone.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where event_id=$1", [tombstoneEvent])).rows[0].denial_code).toBe("channel_not_approved");
    await db.query("select public.approve_slack_channel($1,$2,'C_EXPLICIT',$3,true)", [installation.installation_id, org, user]);
    await db.query("select public.revoke_slack_channel_approval($1,$2,'C_EXPLICIT','owner_disabled')", [team, app]);
    const explicitEvent = randomUUID();
    const explicit = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_EXPLICIT','1.4','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, explicitEvent, org, installation.installation_id])).rows[0];
    expect(explicit.job_id).toBeNull();
    await db.query("select public.approve_slack_channel($1,$2,'C_RECONNECT',$3,true)", [installation.installation_id, org, user]);
    await db.query("select public.revoke_slack_installation($1,$2,'tokens_revoked')", [team, app]);
    await db.query("select * from public.upsert_slack_installation($1,$2,$3,'Policy test','B_POLICY','xoxb-token-2',array['links:read','links:write','channels:read','groups:read','users:read'],$4,'policy-key')", [org, team, app, user]);
    await db.query("select * from public.set_slack_preview_policy($1,$2,$3,true)", [installation.installation_id, org, user]);
    const reconnectEvent = randomUUID();
    const reconnect = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,2,'C_RECONNECT','1.5','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, reconnectEvent, org, installation.installation_id])).rows[0];
    expect(reconnect.job_id).toBeTruthy();
    await db.query("delete from public.slack_preview_policies where installation_id=$1", [installation.installation_id]);
    const missingPolicyEvent = randomUUID();
    const missingPolicy = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,2,'C_RECONNECT','1.6','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, missingPolicyEvent, org, installation.installation_id])).rows[0];
    expect(missingPolicy.accepted).toBe(false);
    expect(missingPolicy.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where event_id=$1", [missingPolicyEvent])).rows[0].denial_code).toBe("previews_disabled");
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
});

it("backfills unknown revoked approvals as denials but leaves lifecycle revocations reconnectable", async () => {
  if (!dbUrl) throw new Error("Missing TEST_SUPABASE_DB_URL");
  const parsed = new URL(dbUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.port !== "54329") throw new Error("Slack workspace policy integration requires local Postgres at 127.0.0.1:54329");
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const org = randomUUID();
  const user = randomUUID();
  try {
    await db.query("begin");
    await db.query(foundation);
    await db.query("insert into auth.users(id) values($1)", [user]);
    await db.query("insert into public.organizations(id,name) values($1,'backfill test')", [org]);
    await db.query("insert into public.memberships(user_id,org_id,role,access_status) values($1,$2,'owner','active')", [user, org]);
    const unknown = (await db.query("select * from public.upsert_slack_installation($1,'T_BACKFILL_UNKNOWN','A_BACKFILL','Backfill','B_BACKFILL','xoxb-token',array['links:read'],$2,'backfill-key')", [org, user])).rows[0].installation_id;
    const lifecycle = (await db.query("select * from public.upsert_slack_installation($1,'T_BACKFILL_LIFECYCLE','A_BACKFILL','Backfill','B_BACKFILL','xoxb-token',array['links:read'],$2,'backfill-key')", [org, user])).rows[0].installation_id;
    const identity = (await db.query("select * from public.upsert_slack_installation($1,'T_BACKFILL_IDENTITY','A_BACKFILL','Backfill','B_BACKFILL','xoxb-token',array['links:read'],$2,'backfill-key')", [org, user])).rows[0].installation_id;
    await db.query("insert into public.slack_channel_approvals(installation_id,org_id,channel_id,approved_by,sharing_policy_acknowledged,status,revoked_at,revoked_reason) values($1,$2,'C_UNKNOWN',$3,true,'revoked',now(),null),($4,$2,'C_LIFECYCLE',$3,true,'revoked',now(),'tokens_revoked'),($5,$2,'C_IDENTITY',$3,true,'revoked',now(),'slack_identity_error')", [unknown, org, user, lifecycle, identity]);
    await db.query(migration);
    expect((await db.query("select denied_reason from public.slack_channel_denials where installation_id=$1 and channel_id='C_UNKNOWN'", [unknown])).rows[0].denied_reason).toBe("legacy_channel_revoked");
    expect((await db.query("select count(*)::int as count from public.slack_channel_denials where installation_id=$1 and channel_id='C_LIFECYCLE'", [lifecycle])).rows[0].count).toBe(0);
    expect((await db.query("select count(*)::int as count from public.slack_channel_denials where installation_id=$1 and channel_id='C_IDENTITY'", [identity])).rows[0].count).toBe(0);
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
});
