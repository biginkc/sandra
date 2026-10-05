import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { Client } from "pg";
import { expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "../../src/lib/testing/loopback-postgres-url";

const dbUrl = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const migration = readFileSync(new URL("./20261007130000_slack_canary_safety.sql", import.meta.url), "utf8");

it("keeps provider safety behind the service-only boolean RPC", async () => {
  const db = new Client({ connectionString: dbUrl });
  await db.connect();
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const ownerId = randomUUID();
  const contactId = randomUUID();
  const foreignContactId = randomUUID();
  const propertyId = randomUUID();
  const siblingPropertyId = randomUUID();
  const runId = randomUUID();
  const marker = `SLACK PREVIEW CANARY ${runId}`;
  const propertyNotes = `${marker}; synthetic only; no seller contact`;
  const contactNotes = `${marker}; synthetic only; no phone; no outreach`;

  const safety = async (input: {
    orgId?: string | null;
    propertyId?: string | null;
    contactId?: string | null;
    runId?: string | null;
  } = {}) => {
    await db.query("set local role service_role");
    try {
      const row = await db.query<{ ok: boolean }>(
        "select public.get_slack_canary_provider_safety($1::uuid,$2::uuid,$3::uuid,$4::uuid) as ok",
        [
          "orgId" in input ? input.orgId : orgId,
          "propertyId" in input ? input.propertyId : propertyId,
          "contactId" in input ? input.contactId : contactId,
          "runId" in input ? input.runId : runId,
        ],
      );
      return row.rows[0]?.ok === true;
    } finally {
      await db.query("reset role");
    }
  };

  try {
    await db.query("begin");
    await db.query(migration);
    await db.query("set local session_replication_role = replica");
    await db.query("insert into public.organizations(id,name) values ($1,$2),($3,$4)", [orgId, `canary-${orgId}`, foreignOrgId, `foreign-${foreignOrgId}`]);
    await db.query("insert into auth.users(id) values ($1),($2)", [ownerId, randomUUID()]);
    await db.query(
      "insert into public.contacts(id,org_id,first_name,notes) values ($1,$2,'Canary',$3),($4,$5,'Foreign',null)",
      [contactId, orgId, contactNotes, foreignContactId, foreignOrgId],
    );
    await db.query(
      "insert into public.properties(id,org_id,address,state,homeowner_contact_id,notes) values ($1,$2,'Canary Lane','MO',$3,$4),($5,$2,'Sibling Lane','MO',$3,null)",
      [propertyId, orgId, contactId, propertyNotes, siblingPropertyId],
    );

    const privilege = await db.query<{
      service_execute: boolean;
      anon_execute: boolean;
      authenticated_execute: boolean;
      ledger_select: boolean;
      phone_index_select: boolean;
    }>(
      `select
         has_function_privilege('service_role', 'public.get_slack_canary_provider_safety(uuid,uuid,uuid,uuid)', 'execute') as service_execute,
         has_function_privilege('anon', 'public.get_slack_canary_provider_safety(uuid,uuid,uuid,uuid)', 'execute') as anon_execute,
         has_function_privilege('authenticated', 'public.get_slack_canary_provider_safety(uuid,uuid,uuid,uuid)', 'execute') as authenticated_execute,
         has_table_privilege('service_role', 'public.rep_sms_delivery_ledger', 'select') as ledger_select,
         has_table_privilege('service_role', 'public.contact_phone_numbers', 'select') as phone_index_select`,
    );
    expect(privilege.rows[0]).toEqual({ service_execute: true, anon_execute: false, authenticated_execute: false, ledger_select: false, phone_index_select: true });
    expect(await safety()).toBe(true);

    await db.query(
      "insert into public.contact_phone_numbers(contact_id,slot,org_id,e164) values ($1,1,$2,'+18165550123')",
      [contactId, orgId],
    );
    expect(await safety()).toBe(false);
    await db.query("delete from public.contact_phone_numbers where contact_id=$1 and slot=1", [contactId]);

    expect(await safety({ orgId: foreignOrgId })).toBe(false);
    expect(await safety({ propertyId: randomUUID() })).toBe(false);
    expect(await safety({ contactId: foreignContactId })).toBe(false);
    expect(await safety({ runId: randomUUID() })).toBe(false);
    expect(await safety({ orgId: null, propertyId: null, contactId: null, runId: null })).toBe(false);

    const obligationId = randomUUID();
    await db.query(
      "insert into public.rep_sms_obligations(id,org_id,property_id,attempt_id,actor_user_id) values ($1,$2,$3,$4,$5)",
      [obligationId, orgId, propertyId, randomUUID(), ownerId],
    );
    expect(await safety()).toBe(false);
    await db.query("delete from public.rep_sms_obligations where id=$1", [obligationId]);

    const ledgerId = randomUUID();
    await db.query(
      `insert into public.rep_sms_delivery_ledger(
         id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,
         provider,provider_account_id,provider_sender_id,from_number,to_number,body,claim_token
       ) values ($1,$2,$3,$4,$5,$6,$7,'test','account','sender','+18165550100','+18165550101','synthetic',$8)`,
      [ledgerId, orgId, ownerId, randomUUID(), propertyId, contactId, randomUUID(), randomUUID()],
    );
    expect(await safety()).toBe(false);
    await db.query("delete from public.rep_sms_delivery_ledger where id=$1", [ledgerId]);

    const siblingLedgerId = randomUUID();
    await db.query(
      `insert into public.rep_sms_delivery_ledger(
         id,org_id,actor_user_id,submission_key,property_id,contact_id,sender_assignment_id,
         provider,provider_account_id,provider_sender_id,from_number,to_number,body,claim_token
       ) values ($1,$2,$3,$4,$5,$6,$7,'test','account2','sender2','+18165550100','+18165550101','synthetic',$8)`,
      [siblingLedgerId, orgId, ownerId, randomUUID(), siblingPropertyId, contactId, randomUUID(), randomUUID()],
    );
    expect(await safety()).toBe(false);
    await db.query("delete from public.rep_sms_delivery_ledger where id=$1", [siblingLedgerId]);

    const intentId = randomUUID();
    await db.query(
      `insert into public.dialpad_call_intents(
         id,org_id,connection_id,rep_user_id,binding_id,dialpad_user_id,property_id,contact_id,
         phone_slot,destination_e164,assignment_episode_id,custom_data,idempotency_key,request_hash,expires_at
       ) values ($1,$2,$3,$4,$5,'12345',$6,$7,1,'+18165550100',$8,$9,$10,$11,now()+interval '1 hour')`,
      [intentId, orgId, randomUUID(), ownerId, randomUUID(), propertyId, contactId, randomUUID(), `sandra.dialpad.v1.${"a".repeat(48)}`, randomUUID(), "0".repeat(64)],
    );
    expect(await safety()).toBe(false);
    await db.query("delete from public.dialpad_call_intents where id=$1", [intentId]);

    const siblingIntentId = randomUUID();
    await db.query(
      `insert into public.dialpad_call_intents(
         id,org_id,connection_id,rep_user_id,binding_id,dialpad_user_id,property_id,contact_id,
         phone_slot,destination_e164,assignment_episode_id,custom_data,idempotency_key,request_hash,expires_at
       ) values ($1,$2,$3,$4,$5,'12346',$6,$7,1,'+18165550100',$8,$9,$10,$11,now()+interval '1 hour')`,
      [siblingIntentId, orgId, randomUUID(), ownerId, randomUUID(), siblingPropertyId, contactId, randomUUID(), `sandra.dialpad.v1.${"b".repeat(48)}`, randomUUID(), "1".repeat(64)],
    );
    expect(await safety()).toBe(false);
    await db.query("delete from public.dialpad_call_intents where id=$1", [siblingIntentId]);
  } finally {
    await db.query("rollback");
    await db.end();
  }
});
