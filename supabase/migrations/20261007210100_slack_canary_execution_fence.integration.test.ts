import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Client } from "pg";
import { expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const dbUrl = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const safetyMigration = readFileSync(new URL("./20261007210000_slack_canary_safety.sql", import.meta.url), "utf8");
const foundationMigration = readFileSync(new URL("./20261003130001_slack_lead_unfurl_foundation.sql", import.meta.url), "utf8");
const policyMigration = readFileSync(new URL("./20261003160000_slack_workspace_preview_policy.sql", import.meta.url), "utf8");
const fenceMigration = readFileSync(new URL("./20261007210100_slack_canary_execution_fence.sql", import.meta.url), "utf8");

const callAsServiceRole = async (db: Client, input: {
  jobId: string;
  claimToken: string;
  privateClaimToken: string;
  orgId: string;
  propertyId: string;
  runId: string;
  canonicalURL: string;
}) => {
  await db.query("begin");
  try {
    await db.query("set local role service_role");
    const result = await db.query<{ ok: boolean }>(
      "select public.claim_slack_canary_execution($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::text) as ok",
      [input.jobId, input.claimToken, input.privateClaimToken, input.orgId, input.propertyId, input.runId, input.canonicalURL],
    );
    await db.query("commit");
    return result.rows[0]?.ok === true;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
};

const dispatchGuard = async (db: Client, input: {
  jobId: string;
  claimToken: string;
  installationId: string;
  orgId: string;
  channelId: string;
  posterId: string;
}) => {
  await db.query("begin");
  try {
    await db.query("set local role service_role");
    const result = await db.query<{ ok: boolean }>(
      "select public.guard_slack_unfurl_dispatch($1::uuid,$2::uuid,$3::uuid,1,$4::uuid,$5::text,$6::text) as ok",
      [input.jobId, input.claimToken, input.installationId, input.orgId, input.channelId, input.posterId],
    );
    await db.query("commit");
    return result.rows[0]?.ok === true;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
};

const finish = async (db: Client, jobId: string, claimToken: string) => {
  await db.query("begin");
  try {
    await db.query("set local role service_role");
    const result = await db.query<{ ok: boolean }>(
      "select public.finish_slack_unfurl_job($1::uuid,$2::uuid,'succeeded',null) as ok",
      [jobId, claimToken],
    );
    await db.query("commit");
    return result.rows[0]?.ok === true;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
};

it("CASes one private canary execution token and fences stale or invalid callers", async () => {
  const first = new Client({ connectionString: dbUrl });
  const second = new Client({ connectionString: dbUrl });
  await first.connect();
  await second.connect();

  const orgId = randomUUID();
  const ownerId = randomUUID();
  const contactId = randomUUID();
  const propertyId = randomUUID();
  const extraMessageId = randomUUID();
  const runId = randomUUID();
  const jobId = randomUUID();
  const receiptId = randomUUID();
  const expiredJobId = randomUUID();
  const expiredReceiptId = randomUUID();
  const installationId = randomUUID();
  const canonicalURL = `https://sandra.bmhgroupkc.com/leads/${propertyId}`;
  const originalToken = randomUUID();
  const privateA = randomUUID();
  const privateB = randomUUID();
  const marker = `SLACK PREVIEW CANARY ${runId}`;
  const propertyNotes = `${marker}; synthetic only; no seller contact`;
  const contactNotes = `${marker}; synthetic only; no phone; no outreach`;

  try {
    await first.query("begin");
    const foundationExists = (await first.query<{ exists: boolean }>("select to_regclass('public.slack_unfurl_jobs') is not null as exists")).rows[0]?.exists === true;
    if (!foundationExists) {
      await first.query(foundationMigration);
      await first.query(policyMigration);
    }
    await first.query(safetyMigration);
    await first.query(fenceMigration);
    await first.query("commit");

    await first.query("set session_replication_role = replica");
    await first.query("insert into public.organizations(id,name) values ($1,$2)", [orgId, `canary-${orgId}`]);
    await first.query("insert into auth.users(id) values ($1)", [ownerId]);
    await first.query(
      "insert into public.memberships(user_id,org_id,role,access_status,acquisitions_enabled,hugo_config,my_leads_revision) values ($1,$2,'owner','active',false,'{}',0)",
      [ownerId, orgId],
    );
    await first.query(
      "insert into public.contacts(id,org_id,first_name,notes) values ($1,$2,'Canary',$3)",
      [contactId, orgId, contactNotes],
    );
    await first.query(
      "insert into public.properties(id,org_id,address,state,homeowner_contact_id,notes) values ($1,$2,'Canary Lane','MO',$3,$4)",
      [propertyId, orgId, contactId, propertyNotes],
    );
    await first.query(
      `insert into public.messages(id,org_id,channel,direction,property_id,contact_id,body,status,metadata)
       values ($1,$2,'sms','outbound',$3,$4,'Historical canary one','delivered',$5::jsonb),
              ($6,$2,'sms','inbound',$3,$4,'Historical canary two','received',$5::jsonb),
              ($7,$2,'sms','outbound',null,$4,'Historical canary three','delivered',$5::jsonb)`,
      [randomUUID(), orgId, propertyId, contactId, JSON.stringify({ canaryRunId: runId }), randomUUID(), randomUUID()],
    );
    await first.query(
      "insert into public.slack_installations(id,org_id,team_id,app_id,bot_user_id,bot_token_encrypted,scopes,installed_by) values ($1,$2,'T_CANARY','A_CANARY','B_CANARY',decode('00','hex'),ARRAY['links:read','links:write'], $3)",
      [installationId, orgId, ownerId],
    );
    await first.query(
      "insert into public.slack_account_links(installation_id,org_id,user_id,slack_user_id,status) values ($1,$2,$3,'U123','active')",
      [installationId, orgId, ownerId],
    );
    await first.query(
      "insert into public.slack_channel_approvals(installation_id,org_id,channel_id,sharing_policy_acknowledged,status,approved_by) values ($1,$2,'C123',true,'active',$3)",
      [installationId, orgId, ownerId],
    );
    await first.query("insert into public.slack_preview_policies(installation_id,org_id) values ($1,$2)", [installationId, orgId]);
    await first.query(
      "insert into public.slack_event_receipts(id,team_id,app_id,event_id,event_type,event_time,channel_id,message_ts,poster_slack_user_id,status) values ($1,'T_CANARY','A_CANARY',$2,'link_shared',now(),'C123','171.1','U123','accepted'),($3,'T_CANARY','A_CANARY',$4,'link_shared',now(),'C123','171.2','U123','accepted')",
      [receiptId, randomUUID(), expiredReceiptId, randomUUID()],
    );
    await first.query(
      `insert into public.slack_unfurl_jobs(
         id,receipt_id,installation_id,installation_version,org_id,team_id,app_id,channel_id,message_ts,poster_slack_user_id,
         event_time,status,attempts,max_attempts,next_attempt_at,lease_expires_at,claim_token,expires_at
       ) values
         ($1,$2,$7,1,$3,'T_CANARY','A_CANARY','C123','171.1','U123',now(),'processing',1,5,now(),now()+interval '60 seconds',$4,now()+interval '15 minutes'),
         ($5,$6,$7,1,$3,'T_CANARY','A_CANARY','C123','171.2','U123',now(),'processing',1,5,now(),now()-interval '1 second',$4,now()+interval '15 minutes')`,
      [jobId, receiptId, orgId, originalToken, expiredJobId, expiredReceiptId, installationId],
    );
    await first.query("insert into public.slack_unfurl_job_urls(job_id,url_key) values ($1,$2),($3,$2)", [jobId, canonicalURL, expiredJobId]);
    await first.query("reset session_replication_role");

    const privileges = await first.query<{ service_execute: boolean; anon_execute: boolean; authenticated_execute: boolean }>(
      `select
         has_function_privilege('service_role', 'public.claim_slack_canary_execution(uuid,uuid,uuid,uuid,uuid,uuid,text)', 'execute') as service_execute,
         has_function_privilege('anon', 'public.claim_slack_canary_execution(uuid,uuid,uuid,uuid,uuid,uuid,text)', 'execute') as anon_execute,
         has_function_privilege('authenticated', 'public.claim_slack_canary_execution(uuid,uuid,uuid,uuid,uuid,uuid,text)', 'execute') as authenticated_execute`,
    );
    expect(privileges.rows[0]).toEqual({ service_execute: true, anon_execute: false, authenticated_execute: false });

    await first.query(
      "insert into public.messages(id,org_id,channel,direction,property_id,contact_id,body,status,metadata) values ($1,$2,'sms','outbound',$3,$4,'Unexpected metadata','delivered','{}'::jsonb)",
      [extraMessageId, orgId, propertyId, contactId],
    );
    expect(await callAsServiceRole(first, { jobId, claimToken: originalToken, privateClaimToken: randomUUID(), orgId, propertyId, runId, canonicalURL })).toBe(false);
    await first.query("delete from public.messages where id=$1", [extraMessageId]);

    const refusal = async () => callAsServiceRole(first, {
      jobId,
      claimToken: originalToken,
      privateClaimToken: randomUUID(),
      orgId,
      propertyId,
      runId,
      canonicalURL,
    });
    await first.query("update public.slack_unfurl_jobs set attempts=2 where id=$1", [jobId]);
    expect(await refusal()).toBe(false);
    await first.query("update public.slack_unfurl_jobs set attempts=1 where id=$1", [jobId]);
    await first.query("update public.slack_unfurl_jobs set status='queued' where id=$1", [jobId]);
    expect(await refusal()).toBe(false);
    await first.query("update public.slack_unfurl_jobs set status='processing' where id=$1", [jobId]);
    await first.query("update public.slack_unfurl_jobs set lease_expires_at=now()+interval '121 seconds' where id=$1", [jobId]);
    expect(await refusal()).toBe(false);
    await first.query("update public.slack_unfurl_jobs set lease_expires_at=now()+interval '60 seconds' where id=$1", [jobId]);
    await first.query("update public.slack_unfurl_jobs set event_time=now()-interval '16 minutes' where id=$1", [jobId]);
    expect(await refusal()).toBe(false);
    await first.query("update public.slack_unfurl_jobs set event_time=now() where id=$1", [jobId]);

    expect(await callAsServiceRole(first, { jobId, claimToken: originalToken, privateClaimToken: randomUUID(), orgId, propertyId, runId, canonicalURL: `${canonicalURL}?other` })).toBe(false);
    expect(await callAsServiceRole(first, { jobId, claimToken: originalToken, privateClaimToken: randomUUID(), orgId, propertyId, runId: randomUUID(), canonicalURL })).toBe(false);
    expect(await callAsServiceRole(first, { jobId, claimToken: originalToken, privateClaimToken: randomUUID(), orgId: randomUUID(), propertyId, runId, canonicalURL })).toBe(false);
    expect(await callAsServiceRole(first, { jobId: expiredJobId, claimToken: originalToken, privateClaimToken: randomUUID(), orgId, propertyId, runId, canonicalURL })).toBe(false);

    const beforeWinningCas = (await first.query(
      "select status, attempts, lease_expires_at::text, next_attempt_at::text, expires_at::text from public.slack_unfurl_jobs where id=$1",
      [jobId],
    )).rows[0];
    const [wonA, wonB] = await Promise.all([
      callAsServiceRole(first, { jobId, claimToken: originalToken, privateClaimToken: privateA, orgId, propertyId, runId, canonicalURL }),
      callAsServiceRole(second, { jobId, claimToken: originalToken, privateClaimToken: privateB, orgId, propertyId, runId, canonicalURL }),
    ]);
    expect([wonA, wonB].filter(Boolean)).toHaveLength(1);
    const winnerToken = wonA ? privateA : privateB;
    const afterWinningCas = (await first.query(
      "select claim_token::text, status, attempts, lease_expires_at::text, next_attempt_at::text, expires_at::text from public.slack_unfurl_jobs where id=$1",
      [jobId],
    )).rows[0];
    expect(afterWinningCas.claim_token).toBe(winnerToken);
    expect(afterWinningCas).toMatchObject(beforeWinningCas);
    expect(await dispatchGuard(first, { jobId, claimToken: originalToken, installationId, orgId, channelId: "C123", posterId: "U123" })).toBe(false);
    expect(await dispatchGuard(first, { jobId, claimToken: winnerToken, installationId, orgId, channelId: "C123", posterId: "U123" })).toBe(true);
    expect(await finish(first, jobId, originalToken)).toBe(false);
    expect(await finish(first, jobId, winnerToken)).toBe(true);
  } finally {
    await first.query("delete from public.slack_unfurl_jobs where id in ($1,$2)", [jobId, expiredJobId]).catch(() => undefined);
    await first.query("delete from public.slack_event_receipts where id in ($1,$2)", [receiptId, expiredReceiptId]).catch(() => undefined);
    await first.query("delete from public.slack_installations where id=$1", [installationId]).catch(() => undefined);
    await first.query("delete from public.messages where org_id=$1", [orgId]).catch(() => undefined);
    await first.query("delete from public.properties where id=$1", [propertyId]).catch(() => undefined);
    await first.query("delete from public.contacts where id=$1", [contactId]).catch(() => undefined);
    await first.query("delete from public.memberships where org_id=$1", [orgId]).catch(() => undefined);
    await first.query("delete from public.organizations where id=$1", [orgId]).catch(() => undefined);
    await first.query("delete from auth.users where id=$1", [ownerId]).catch(() => undefined);
    await first.end();
    await second.end();
  }
});
