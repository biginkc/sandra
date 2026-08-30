import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  "supabase/migrations/20260829194500_esign_foundation.sql",
  "utf8",
);
const sourceUrl = process.env.TEST_SUPABASE_DB_URL;
const databaseName = `sandra_esign_race_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let admin: Client;
let setup: Client;
let isolatedUrl: string;

function databaseUrl(name: string): string {
  if (!sourceUrl) throw new Error("TEST_SUPABASE_DB_URL is required");
  const url = new URL(sourceUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function setServiceRole(client: Client): Promise<void> {
  await client.query("select set_config('request.jwt.claim.role','service_role',false)");
}

beforeAll(async () => {
  if (!sourceUrl) throw new Error("TEST_SUPABASE_DB_URL is required");
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`create database ${databaseName}`);
  isolatedUrl = databaseUrl(databaseName);
  setup = new Client({ connectionString: isolatedUrl });
  await setup.connect();
  await setup.query(`
    create schema auth;
    create schema storage;
    create schema extensions;
    create extension pgcrypto with schema extensions;

    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;

    create table public.organizations (id uuid primary key);
    create table public.memberships (
      user_id uuid not null references auth.users(id),
      org_id uuid not null references public.organizations(id),
      role text not null,
      access_status text not null default 'active',
      deletion_prepared_at timestamptz,
      access_expires_at timestamptz,
      primary key (user_id, org_id)
    );
    create table public.webhook_consumers (
      id uuid primary key default gen_random_uuid(),
      org_id uuid references public.organizations(id),
      name text not null unique,
      secret_hash text not null,
      consumer_type text not null,
      default_source text,
      enabled boolean not null default true,
      revoked_at timestamptz,
      created_by uuid,
      constraint webhook_consumers_type_check check (true),
      constraint webhook_consumers_type_source_match_check check (true)
    );
    create table public.contacts (
      id uuid primary key,
      org_id uuid not null references public.organizations(id),
      email text,
      constraint contacts_id_org_key unique (id, org_id)
    );
    create table public.properties (
      id uuid primary key,
      org_id uuid not null references public.organizations(id),
      homeowner_contact_id uuid,
      constraint properties_id_org_key unique (id, org_id),
      constraint properties_homeowner_contact_org_fkey
        foreign key (homeowner_contact_id, org_id)
        references public.contacts(id, org_id)
    );
    create table public.lead_events (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null references public.organizations(id),
      property_id uuid not null,
      actor_type text not null,
      actor_id uuid,
      event_type text not null,
      payload jsonb not null default '{}'::jsonb,
      source_type text,
      source_id uuid
    );
    create unique index lead_events_source_key
      on public.lead_events(source_type, source_id)
      where source_id is not null;
    create function public.hugo_has_active_org_access(uuid)
      returns boolean language sql stable as $$ select true $$;

    create table storage.buckets (
      id text primary key,
      name text not null,
      public boolean not null default false,
      file_size_limit bigint,
      allowed_mime_types text[]
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets(id),
      name text not null,
      metadata jsonb,
      unique (bucket_id, name)
    );
    create function storage.foldername(text) returns text[]
      language sql immutable as $$ select string_to_array($1, '/') $$;
  `);
  await setup.query(migrationSql);
}, 60_000);

afterAll(async () => {
  await setup?.end();
  if (admin) {
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()",
      [databaseName],
    );
    await admin.query(`drop database if exists ${databaseName} with (force)`);
    await admin.end();
  }
});

describe("eSign foundation production lease contention", () => {
  it("serializes same-kind and reminder-vs-void claims at the fixed ten-minute boundary", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const signerId = crypto.randomUUID();
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.contacts (id,org_id,email) values ($1,$2,'seller@example.com')",
      [contactId, orgId],
    );
    await setup.query(
      "insert into public.properties (id,org_id,homeowner_contact_id) values ($1,$2,$3)",
      [propertyId, orgId, contactId],
    );
    await setup.query(
      `insert into public.esign_template_staging_sources (
         id,org_id,storage_path,source_filename,source_size_bytes,
         content_type,source_sha256,created_by
       ) values ($1::uuid,$2::uuid,($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf','source.pdf',1024,
         'application/pdf',repeat('a',64),$3::uuid)`,
      [sourceId, orgId, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,
         sign_template_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         'provider-template',$3::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',now(),'finalized',$4::uuid,$4::uuid
       )`,
      [templateId, orgId, sourceId, userId],
    );
    await setup.query(
      `insert into public.esign_requests (
         id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,
         delivery_state,sign_request_id,sent_at,send_intent_id,payload_hash,created_by
       ) values (
         $1,$2,$3,$4,
         '[{"role":"Seller","name":"Test Seller","emailAddress":"seller@example.com"}]',
         '{"seller_name":"Test Seller","property_address":"123 Test","offer_price":"1","closing_date":"2026-09-01","earnest_money":"1"}',
         'sent','provider-request',now(),gen_random_uuid(),repeat('b',64),$5
       )`,
      [requestId, orgId, propertyId, templateId, userId],
    );
    await setup.query(
      `insert into public.esign_request_signers (
         id,org_id,request_id,role_name,signer_order,signer_name,signer_email,
         provider_signature_id
       ) values ($1,$2,$3,'Seller',0,'Test Seller','seller@example.com','provider-signature')`,
      [signerId, orgId, requestId],
    );

    const first = new Client({ connectionString: isolatedUrl });
    const second = new Client({ connectionString: isolatedUrl });
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([setServiceRole(first), setServiceRole(second)]);
    try {
      const reminderTokens = [crypto.randomUUID(), crypto.randomUUID()];
      const reminderRace = await Promise.all([
        first.query<{ outcome: string }>(
          "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [orgId, requestId, signerId, reminderTokens[0]],
        ),
        second.query<{ outcome: string }>(
          "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [orgId, requestId, signerId, reminderTokens[1]],
        ),
      ]);
      expect(reminderRace.map((result) => result.rows[0].outcome).sort()).toEqual([
        "claimed",
        "in_progress",
      ]);

      await setup.query(
        "update public.esign_request_signers set reminder_claim_token=null, reminder_claimed_at=null where id=$1",
        [signerId],
      );
      const mixedRace = await Promise.all([
        first.query<{ outcome: string }>(
          "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
          [orgId, requestId, signerId, crypto.randomUUID()],
        ),
        second.query<{ outcome: string }>(
          "select outcome from public.claim_esign_request_void($1,$2,$3)",
          [orgId, requestId, crypto.randomUUID()],
        ),
      ]);
      expect(mixedRace.map((result) => result.rows[0].outcome).sort()).toEqual([
        "claimed",
        "in_progress",
      ]);

      await setup.query(
        `update public.esign_request_signers
         set reminder_claim_token=null, reminder_claimed_at=null where id=$1`,
        [signerId],
      );
      await setup.query(
        `update public.esign_requests
         set void_claim_token=null, void_claimed_at=null where id=$1`,
        [requestId],
      );
      const voidRace = await Promise.all([
        first.query<{ outcome: string }>(
          "select outcome from public.claim_esign_request_void($1,$2,$3)",
          [orgId, requestId, crypto.randomUUID()],
        ),
        second.query<{ outcome: string }>(
          "select outcome from public.claim_esign_request_void($1,$2,$3)",
          [orgId, requestId, crypto.randomUUID()],
        ),
      ]);
      expect(voidRace.map((result) => result.rows[0].outcome).sort()).toEqual([
        "claimed",
        "in_progress",
      ]);

      await setup.query(
        "update public.esign_requests set void_claimed_at=now()-interval '9 minutes 59 seconds' where id=$1",
        [requestId],
      );
      expect(
        (
          await first.query<{ outcome: string }>(
            "select outcome from public.claim_esign_request_void($1,$2,$3)",
            [orgId, requestId, crypto.randomUUID()],
          )
        ).rows[0].outcome,
      ).toBe("in_progress");
      await setup.query(
        "update public.esign_requests set void_claimed_at=now()-interval '10 minutes' where id=$1",
        [requestId],
      );
      expect(
        (
          await second.query<{ outcome: string }>(
            "select outcome from public.claim_esign_request_void($1,$2,$3)",
            [orgId, requestId, crypto.randomUUID()],
          )
        ).rows[0].outcome,
      ).toBe("claimed");
      await setup.query(
        "update public.esign_requests set void_claim_token=null, void_claimed_at=null where id=$1",
        [requestId],
      );
      await first.query(
        "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
        [orgId, requestId, signerId, crypto.randomUUID()],
      );
      await setup.query(
        "update public.esign_request_signers set reminder_claimed_at=now()-interval '9 minutes 59 seconds' where id=$1",
        [signerId],
      );
      expect(
        (
          await second.query<{ outcome: string }>(
            "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
            [orgId, requestId, signerId, crypto.randomUUID()],
          )
        ).rows[0].outcome,
      ).toBe("in_progress");
      await setup.query(
        "update public.esign_request_signers set reminder_claimed_at=now()-interval '10 minutes' where id=$1",
        [signerId],
      );
      expect(
        (
          await first.query<{ outcome: string }>(
            "select outcome from public.claim_esign_signer_reminder($1,$2,$3,$4)",
            [orgId, requestId, signerId, crypto.randomUUID()],
          )
        ).rows[0].outcome,
      ).toBe("claimed");
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("converges simultaneous duplicate webhook claims onto one active receipt", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      `select public.upsert_org_esign_integration(
         $1,'synthetic-api-key','-key','synthetic-client',repeat('a',64),
         $2,'synthetic-encryption-key'
       )`,
      [orgId, userId],
    );
    const consumerId = (
      await setup.query<{ callback_consumer_id: string }>(
        "select callback_consumer_id from public.org_esign_integrations where org_id=$1",
        [orgId],
      )
    ).rows[0].callback_consumer_id;
    const first = new Client({ connectionString: isolatedUrl });
    const second = new Client({ connectionString: isolatedUrl });
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([setServiceRole(first), setServiceRole(second)]);
    const leaseIds = [crypto.randomUUID(), crypto.randomUUID()];
    const eventAt = "2026-08-29T20:00:00.000Z";
    const safeData = JSON.stringify({
      event_time: "1788033600",
      event_type: "signature_request_viewed",
      sign_request_id: "provider-race",
      related_signature_id: "signature-race",
      reported_for_app_id: "synthetic-client",
    });
    const claimSql = `select * from public.claim_esign_webhook_receipt(
      $1,$2,$3,$4,$5,'signature_request_viewed','provider-race',
      'signature-race',$6::timestamptz,$7::jsonb,now(),$8,300
    )`;
    try {
      const claims = await Promise.all([
        first.query<{ outcome: string; receipt_id: string; lease_id: string | null }>(
          claimSql,
          [
            orgId,
            consumerId,
            "c".repeat(64),
            "d".repeat(64),
            "e".repeat(64),
            eventAt,
            safeData,
            leaseIds[0],
          ],
        ),
        second.query<{ outcome: string; receipt_id: string; lease_id: string | null }>(
          claimSql,
          [
            orgId,
            consumerId,
            "c".repeat(64),
            "d".repeat(64),
            "e".repeat(64),
            eventAt,
            safeData,
            leaseIds[1],
          ],
        ),
      ]);
      const rows = claims.map((claim) => claim.rows[0]);
      expect(rows.map((row) => row.outcome).sort()).toEqual([
        "claimed",
        "in_progress",
      ]);
      expect(new Set(rows.map((row) => row.receipt_id)).size).toBe(1);
      const claimed = rows.find((row) => row.outcome === "claimed");
      const inProgress = rows.find((row) => row.outcome === "in_progress");
      expect(claimed?.lease_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(leaseIds).toContain(claimed?.lease_id);
      expect(inProgress?.lease_id).toBeNull();
      expect(
        (
          await setup.query<{ count: number; attempt_count: number }>(
            `select count(*)::int as count, max(attempt_count)::int as attempt_count
             from public.esign_webhook_receipts
             where org_id=$1 and event_fingerprint=$2`,
            [orgId, "d".repeat(64)],
          )
        ).rows[0],
      ).toEqual({ count: 1, attempt_count: 1 });
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("claims one local request for simultaneous identical send intents", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const sendIntentId = crypto.randomUUID();
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.contacts (id,org_id,email) values ($1,$2,'seller@example.com')",
      [contactId, orgId],
    );
    await setup.query(
      "insert into public.properties (id,org_id,homeowner_contact_id) values ($1,$2,$3)",
      [propertyId, orgId, contactId],
    );
    await setup.query(
      `insert into public.esign_template_staging_sources (
         id,org_id,storage_path,source_filename,source_size_bytes,
         content_type,source_sha256,created_by
       ) values (
         $1::uuid,$2::uuid,($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf',
         'source.pdf',1024,'application/pdf',repeat('a',64),$3::uuid
       )`,
      [sourceId, orgId, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,
         sign_template_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         'provider-template',$3::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',now(),'finalized',$4::uuid,$4::uuid
       )`,
      [templateId, orgId, sourceId, userId],
    );
    await setup.query(
      `select public.upsert_org_esign_integration(
         $1,'synthetic-api-key','-key','synthetic-client',repeat('f',64),
         $2,'synthetic-encryption-key'
       )`,
      [orgId, userId],
    );
    await setup.query(
      `update public.org_esign_integrations
       set callback_verified_at=now(), sending_enabled=true where org_id=$1`,
      [orgId],
    );

    const first = new Client({ connectionString: isolatedUrl });
    const second = new Client({ connectionString: isolatedUrl });
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([setServiceRole(first), setServiceRole(second)]);
    const signerSnapshot = JSON.stringify([
      {
        role: "Seller",
        name: "Test Seller",
        emailAddress: "seller@example.com",
      },
    ]);
    const mergeSnapshot = JSON.stringify({
      seller_name: "Test Seller",
      property_address: "123 Test",
      offer_price: "1",
      closing_date: "2026-09-01",
      earnest_money: "1",
    });
    const claimSql = `select outcome, id from public.create_esign_request(
      $1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,null,$8
    )`;
    try {
      const claims = await Promise.all([
        first.query<{ outcome: string; id: string }>(claimSql, [
          orgId,
          propertyId,
          templateId,
          signerSnapshot,
          mergeSnapshot,
          sendIntentId,
          "b".repeat(64),
          userId,
        ]),
        second.query<{ outcome: string; id: string }>(claimSql, [
          orgId,
          propertyId,
          templateId,
          signerSnapshot,
          mergeSnapshot,
          sendIntentId,
          "b".repeat(64),
          userId,
        ]),
      ]);
      const rows = claims.map((claim) => claim.rows[0]);
      expect(rows.map((row) => row.outcome).sort()).toEqual([
        "created",
        "existing_same_payload",
      ]);
      expect(new Set(rows.map((row) => row.id)).size).toBe(1);
      expect(
        (
          await setup.query<{ requests: number; signers: number; events: number }>(
            `select
               (select count(*)::int from public.esign_requests where org_id=$1 and send_intent_id=$2) as requests,
               (select count(*)::int from public.esign_request_signers signer
                 join public.esign_requests request on request.id=signer.request_id
                 where request.org_id=$1 and request.send_intent_id=$2) as signers,
               (select count(*)::int from public.lead_events event
                 join public.esign_requests request on request.id=event.source_id
                 where request.org_id=$1 and request.send_intent_id=$2
                   and event.source_type='esign_request') as events`,
            [orgId, sendIntentId],
          )
        ).rows[0],
      ).toEqual({ requests: 1, signers: 1, events: 1 });
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });
});
