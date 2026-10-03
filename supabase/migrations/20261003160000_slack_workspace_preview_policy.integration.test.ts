import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const foundation = readFileSync(new URL("../20261003130001_slack_lead_unfurl_foundation.sql", import.meta.url), "utf8");
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
    await db.query("insert into auth.users(id) values($1); insert into public.organizations(id,name) values($2,'policy test'); insert into public.memberships(user_id,org_id,role,access_status) values($1,$2,'owner','active')", [user, org]);
    const installation = (await db.query("select * from public.upsert_slack_installation($1,$2,$3,'Policy test','B_POLICY','xoxb-token',array['links:read','links:write','channels:read','groups:read','users:read'],$4,'policy-key')", [org, team, app, user])).rows[0];
    expect((await db.query("select mode from public.slack_preview_policies where installation_id=$1", [installation.installation_id])).rows[0].mode).toBe("legacy");
    const enabled = (await db.query("select * from public.set_slack_preview_policy($1,$2,$3,true)", [installation.installation_id, org, user])).rows[0];
    expect(enabled.mode).toBe("eligible_internal_channels");
    const event = randomUUID();
    const job = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_AUTO','1.1','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, event, org, installation.installation_id])).rows[0];
    expect(job.job_id).toBeTruthy();
    const revision = (await db.query("select policy_revision from public.slack_unfurl_jobs where id=$1", [job.job_id])).rows[0].policy_revision;
    expect(revision).toBe(enabled.policy_revision);
    const disabled = (await db.query("select * from public.set_slack_preview_policy($1,$2,$3,false)", [installation.installation_id, org, user])).rows[0];
    expect(disabled.mode).toBe("disabled");
    expect((await db.query("select status from public.slack_unfurl_jobs where id=$1", [job.job_id])).rows[0].status).toBe("cancelled");
    const denied = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_AUTO','1.2','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, randomUUID(), org, installation.installation_id])).rows[0];
    expect(denied.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where team_id=$1 and channel_id='C_AUTO' order by created_at desc limit 1", [team])).rows[0].denial_code).toBe("previews_disabled");
    const reenabled = (await db.query("select * from public.set_slack_preview_policy($1,$2,$3,true)", [installation.installation_id, org, user])).rows[0];
    expect(reenabled.policy_revision).toBeGreaterThan(disabled.policy_revision);
    const lifecycle = randomUUID();
    await db.query("select public.process_slack_lifecycle_event($1,$2,$3,'channel_shared',now(),'C_TOMBSTONE',array[]::text[],'channel')", [team, app, lifecycle]);
    expect((await db.query("select count(*)::int as count from public.slack_channel_denials where installation_id=$1 and channel_id='C_TOMBSTONE'", [installation.installation_id])).rows[0].count).toBe(1);
    const tombstoneEvent = randomUUID();
    const tombstone = (await db.query("select * from public.enqueue_slack_unfurl_event($1,$2,$3,'link_shared',now(),$4,$5,1,'C_TOMBSTONE','1.3','U_POLICY',array['https://sandra.bmhgroupkc.com/leads/00000000-0000-4000-8000-000000000001'],null)", [team, app, tombstoneEvent, org, installation.installation_id])).rows[0];
    expect(tombstone.job_id).toBeNull();
    expect((await db.query("select denial_code from public.slack_event_receipts where event_id=$1", [tombstoneEvent])).rows[0].denial_code).toBe("channel_not_approved");
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
});
