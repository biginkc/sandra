import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  "supabase/migrations/20260829194500_esign_foundation.sql",
  "utf8",
);
const reconciliationFenceSql = readFileSync(
  "supabase/migrations/20260901010000_esign_provider_mutation_reconciliation_fence.sql",
  "utf8",
);
const retryReminderFenceSql = readFileSync(
  "supabase/migrations/20260901020000_esign_retry_and_reminder_callback_fences.sql",
  "utf8",
);
const sendUnknownResolutionSql = readFileSync(
  "supabase/migrations/20260902030000_esign_send_unknown_positive_resolution.sql",
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
  await client.query(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
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
  await setup.query(reconciliationFenceSql);
  await setup.query(retryReminderFenceSql);
  await setup.query(sendUnknownResolutionSql);
  await setup.query(sendUnknownResolutionSql);
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
    const memberId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const signerId = crypto.randomUUID();
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into auth.users values ($1)", [memberId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'member')",
      [memberId, orgId],
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
      expect(
        reminderRace.map((result) => result.rows[0].outcome).sort(),
      ).toEqual(["claimed", "in_progress"]);

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
      ).toBe("reconciliation_required");
      expect(
        (
          await setup.query<{ void_claim_token: string }>(
            "select void_claim_token from public.esign_requests where id=$1",
            [requestId],
          )
        ).rows[0].void_claim_token,
      ).not.toBeNull();
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
      ).toBe("reconciliation_required");
      expect(
        (
          await setup.query<{ reminder_claim_token: string }>(
            "select reminder_claim_token from public.esign_request_signers where id=$1",
            [signerId],
          )
        ).rows[0].reminder_claim_token,
      ).not.toBeNull();
      expect(
        (
          await first.query<{ outcome: string }>(
            "select outcome from public.claim_esign_request_void($1,$2,$3)",
            [orgId, requestId, crypto.randomUUID()],
          )
        ).rows[0].outcome,
      ).toBe("reconciliation_required");
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
        first.query<{
          outcome: string;
          receipt_id: string;
          lease_id: string | null;
        }>(claimSql, [
          orgId,
          consumerId,
          "c".repeat(64),
          "d".repeat(64),
          "e".repeat(64),
          eventAt,
          safeData,
          leaseIds[0],
        ]),
        second.query<{
          outcome: string;
          receipt_id: string;
          lease_id: string | null;
        }>(claimSql, [
          orgId,
          consumerId,
          "c".repeat(64),
          "d".repeat(64),
          "e".repeat(64),
          eventAt,
          safeData,
          leaseIds[1],
        ]),
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
    const memberId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const sendIntentId = crypto.randomUUID();
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into auth.users values ($1)", [memberId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'member')",
      [memberId, orgId],
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
          await setup.query<{
            requests: number;
            signers: number;
            events: number;
          }>(
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

  it("publishes only one of two concurrent hidden edit revisions", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const sourceTemplateId = crypto.randomUUID();
    const revisionIds = [crypto.randomUUID(), crypto.randomUUID()];
    const stagingSourceIds = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];
    const sourceProviderTemplateId = `provider-${sourceTemplateId}`;
    const revisionProviderIds = revisionIds.map((id) => `provider-edit-${id}`);
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    for (const sourceId of stagingSourceIds) {
      const sourcePath = `${orgId}/${sourceId}.pdf`;
      await setup.query(
        `insert into storage.objects (bucket_id,name,metadata)
         values ('esign-staging',$1,'{"mimetype":"application/pdf","size":1024}')`,
        [sourcePath],
      );
      await setup.query(
        `insert into public.esign_template_staging_sources (
           id,org_id,storage_path,source_filename,source_size_bytes,
           content_type,source_sha256,created_by
         ) values ($1,$2,$3,'source.pdf',1024,'application/pdf',repeat('a',64),$4)`,
        [sourceId, orgId, sourcePath, userId],
      );
    }
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,
         merge_field_names,sign_template_id,staging_source_id,
         source_filename,source_size_bytes,source_content_type,source_sha256,
         staging_path,finalized_at,lifecycle_state,created_by,updated_by
       ) values (
         $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         $3,$4::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($4::uuid)::text || '.pdf',now(),'finalized',$5::uuid,$5::uuid
       )`,
      [
        sourceTemplateId,
        orgId,
        sourceProviderTemplateId,
        stagingSourceIds[0],
        userId,
      ],
    );
    for (const [index, revisionId] of revisionIds.entries()) {
      await setup.query(
        `insert into public.esign_templates (
           id,org_id,name,document_type,seller_role,signer_roles,
           merge_field_names,sign_template_id,staging_source_id,
           source_filename,source_size_bytes,source_content_type,source_sha256,
           staging_path,lifecycle_state,supersedes_template_id,created_by,updated_by
         ) values (
           $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
           '[{"name":"Seller","order":0}]'::jsonb,
           array['seller_name','property_address','offer_price','closing_date','earnest_money'],
           $3,$4::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
           ($2::uuid)::text || '/' || ($4::uuid)::text || '.pdf','editing',$5::uuid,$6::uuid,$6::uuid
         )`,
        [
          revisionId,
          orgId,
          revisionProviderIds[index],
          stagingSourceIds[index + 1],
          sourceTemplateId,
          userId,
        ],
      );
    }

    const first = new Client({ connectionString: isolatedUrl });
    const second = new Client({ connectionString: isolatedUrl });
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([setServiceRole(first), setServiceRole(second)]);
    const publishSql = `select public.publish_esign_template_edit_revision(
      $1,$2,$3,$4,$5,'Seller','[{"name":"Seller","order":0}]'::jsonb,
      array['seller_name','property_address','offer_price','closing_date','earnest_money'],$6
    ) as result`;
    try {
      const results = await Promise.allSettled([
        first.query<{ result: string }>(publishSql, [
          orgId,
          sourceTemplateId,
          revisionIds[0],
          sourceProviderTemplateId,
          revisionProviderIds[0],
          userId,
        ]),
        second.query<{ result: string }>(publishSql, [
          orgId,
          sourceTemplateId,
          revisionIds[1],
          sourceProviderTemplateId,
          revisionProviderIds[1],
          userId,
        ]),
      ]);
      const successes = results.filter(
        (result) => result.status === "fulfilled",
      ) as PromiseFulfilledResult<{ rows: { result: string }[] }>[];
      const failures = results.filter(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult[];
      expect(successes).toHaveLength(1);
      expect(successes[0].value.rows[0]).toEqual({ result: "published" });
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toMatchObject({
        message: expect.stringMatching(/no longer active or current/i),
      });
      expect(
        (
          await setup.query<{ id: string }>(
            `select id from public.available_esign_templates
             where org_id=$1 order by id`,
            [orgId],
          )
        ).rows,
      ).toHaveLength(1);
      expect(
        (
          await setup.query<{ lifecycle_state: string; count: number }>(
            `select lifecycle_state, count(*)::int as count
             from public.esign_templates
             where id = any($1::uuid[])
             group by lifecycle_state order by lifecycle_state`,
            [revisionIds],
          )
        ).rows,
      ).toEqual([
        { lifecycle_state: "editing", count: 1 },
        { lifecycle_state: "finalized", count: 1 },
      ]);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("serializes retry children and reminder callback reconciliation", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const failedRequestId = crypto.randomUUID();
    const deliveredRequestId = crypto.randomUUID();
    const signerId = crypto.randomUUID();
    const receiptId = crypto.randomUUID();
    const receiptLease = crypto.randomUUID();
    const callbackAt = new Date("2026-09-01T12:00:00.000Z");
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
      closing_date: "2026-09-30",
      earnest_money: "1",
    });

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
       ) values ($1,$2,($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf','source.pdf',1024,
         'application/pdf',repeat('a',64),$3)`,
      [sourceId, orgId, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,
         sign_template_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         'provider-template',$3,'source.pdf',1024,'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',now(),'finalized',$4,$4
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
      `insert into public.esign_requests (
         id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,
         status,delivery_state,error_message,completed_at,send_intent_id,payload_hash,
         created_by,created_at
       ) values (
         $1,$2,$3,$4,$5::jsonb,$6::jsonb,'error','failed','PROVIDER_REJECTED',now(),
         gen_random_uuid(),repeat('b',64),$7,now()-interval '1 minute'
       )`,
      [
        failedRequestId,
        orgId,
        propertyId,
        templateId,
        signerSnapshot,
        mergeSnapshot,
        userId,
      ],
    );

    const first = new Client({ connectionString: isolatedUrl });
    const second = new Client({ connectionString: isolatedUrl });
    await Promise.all([first.connect(), second.connect()]);
    await Promise.all([setServiceRole(first), setServiceRole(second)]);
    const retryInsert = `insert into public.esign_requests (
      id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,
      delivery_state,send_intent_id,payload_hash,retry_of_request_id,created_by
    ) values (gen_random_uuid(),$1,$2,$3,$4::jsonb,$5::jsonb,'sending',
      gen_random_uuid(),repeat('c',64),$6,$7)`;
    try {
      const retryRace = await Promise.allSettled([
        first.query(retryInsert, [
          orgId,
          propertyId,
          templateId,
          signerSnapshot,
          mergeSnapshot,
          failedRequestId,
          userId,
        ]),
        second.query(retryInsert, [
          orgId,
          propertyId,
          templateId,
          signerSnapshot,
          mergeSnapshot,
          failedRequestId,
          userId,
        ]),
      ]);
      expect(
        retryRace.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const retryFailure = retryRace.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(retryFailure?.reason).toMatchObject({
        code: "23505",
        constraint: "esign_requests_one_retry_child_per_source_idx",
      });

      await setup.query(
        `insert into public.esign_requests (
           id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,
           delivery_state,sign_request_id,sent_at,send_intent_id,payload_hash,created_by
         ) values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,'sent','provider-request',now(),
           gen_random_uuid(),repeat('d',64),$7)`,
        [
          deliveredRequestId,
          orgId,
          propertyId,
          templateId,
          signerSnapshot,
          mergeSnapshot,
          userId,
        ],
      );
      await setup.query(
        `insert into public.esign_request_signers (
           id,org_id,request_id,role_name,signer_order,signer_name,signer_email,
           provider_signature_id,reminder_claim_token,reminder_claimed_at
         ) values ($1,$2,$3,'Seller',0,'Test Seller','seller@example.com',
           'provider-signature',$4,$5)`,
        [
          signerId,
          orgId,
          deliveredRequestId,
          crypto.randomUUID(),
          new Date(callbackAt.getTime() - 500),
        ],
      );
      const consumer = await setup.query<{ callback_consumer_id: string }>(
        "select callback_consumer_id from public.org_esign_integrations where org_id=$1",
        [orgId],
      );
      await setup.query(
        `insert into public.esign_webhook_receipts (
           id,org_id,callback_consumer_id,esign_request_id,event_hash,event_fingerprint,
           payload_hash,event_type,sign_request_id,related_signature_id,provider_event_at,
           safe_event_data,received_at,processing_status,processing_started_at,
           processing_lease_id,attempt_count
         ) values ($1,$2,$3,$4,repeat('e',64),repeat('f',64),repeat('a',64),
           'signature_request_remind','provider-request','provider-signature',$5,
           jsonb_build_object(
             'event_time',extract(epoch from $5::timestamptz)::bigint::text,
             'event_type','signature_request_remind',
             'sign_request_id','provider-request',
             'related_signature_id','provider-signature',
             'reported_for_app_id',null
           ),now(),'processing',now(),$6,1)`,
        [
          receiptId,
          orgId,
          consumer.rows[0].callback_consumer_id,
          deliveredRequestId,
          callbackAt,
          receiptLease,
        ],
      );
      const reconcileSql = `select outcome from public.reconcile_esign_reminder_callback(
        $1,$2,$3,$4,'provider-signature',$5
      )`;
      const callbackRace = await Promise.all([
        first.query<{ outcome: string }>(reconcileSql, [
          orgId,
          deliveredRequestId,
          receiptId,
          receiptLease,
          callbackAt,
        ]),
        second.query<{ outcome: string }>(reconcileSql, [
          orgId,
          deliveredRequestId,
          receiptId,
          receiptLease,
          callbackAt,
        ]),
      ]);
      expect(
        callbackRace.map((result) => result.rows[0].outcome).sort(),
      ).toEqual(["already_reconciled", "applied"]);
      expect(
        (
          await setup.query<{
            reminder_claim_token: string | null;
            last_reminded_at: Date;
          }>(
            "select reminder_claim_token,last_reminded_at from public.esign_request_signers where id=$1",
            [signerId],
          )
        ).rows[0],
      ).toMatchObject({
        reminder_claim_token: null,
        last_reminded_at: callbackAt,
      });

      const staleReceiptId = crypto.randomUUID();
      const staleReceiptLease = crypto.randomUUID();
      const newerClaimToken = crypto.randomUUID();
      const staleCallbackAt = new Date(callbackAt.getTime() + 1_000);
      const newerClaimedAt = new Date(callbackAt.getTime() + 5_000);
      await setup.query(
        `update public.esign_request_signers
         set reminder_claim_token=$2,reminder_claimed_at=$3 where id=$1`,
        [signerId, newerClaimToken, newerClaimedAt],
      );
      await setup.query(
        `insert into public.esign_webhook_receipts (
           id,org_id,callback_consumer_id,esign_request_id,event_hash,event_fingerprint,
           payload_hash,event_type,sign_request_id,related_signature_id,provider_event_at,
           safe_event_data,received_at,processing_status,processing_started_at,
           processing_lease_id,attempt_count
         ) values ($1,$2,$3,$4,repeat('b',64),repeat('c',64),repeat('d',64),
           'signature_request_remind','provider-request','provider-signature',$5,
           jsonb_build_object(
             'event_time',extract(epoch from $5::timestamptz)::bigint::text,
             'event_type','signature_request_remind',
             'sign_request_id','provider-request',
             'related_signature_id','provider-signature',
             'reported_for_app_id',null
           ),now(),'processing',now(),$6,1)`,
        [
          staleReceiptId,
          orgId,
          consumer.rows[0].callback_consumer_id,
          deliveredRequestId,
          staleCallbackAt,
          staleReceiptLease,
        ],
      );
      expect(
        (
          await first.query<{ outcome: string }>(reconcileSql, [
            orgId,
            deliveredRequestId,
            staleReceiptId,
            staleReceiptLease,
            staleCallbackAt,
          ])
        ).rows[0],
      ).toEqual({ outcome: "stale_ignored" });
      expect(
        (
          await setup.query<{ reminder_claim_token: string }>(
            "select reminder_claim_token from public.esign_request_signers where id=$1",
            [signerId],
          )
        ).rows[0].reminder_claim_token,
      ).toBe(newerClaimToken);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });

  it("resolves send_unknown to failed only with positive evidence and records actor audit", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const memberId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const operatorRequestId = crypto.randomUUID();
    const automaticRequestId = crypto.randomUUID();
    const metadataRequestId = crypto.randomUUID();
    const metadataMissingLocalRequestId = crypto.randomUUID();
    const sentRequestId = crypto.randomUUID();
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
      closing_date: "2026-09-30",
      earnest_money: "1",
    });

    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into auth.users values ($1)", [memberId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'member')",
      [memberId, orgId],
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
       ) values ($1,$2,($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf','source.pdf',1024,
         'application/pdf',repeat('a',64),$3)`,
      [sourceId, orgId, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,
         sign_template_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         'provider-template',$3,'source.pdf',1024,'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',now(),'finalized',$4,$4
       )`,
      [templateId, orgId, sourceId, userId],
    );
    await setup.query(
      `insert into public.esign_requests (
         id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,
         delivery_state,status,error_message,completed_at,sign_request_id,sent_at,send_intent_id,payload_hash,created_by
       ) values
         ($1,$5,$6,$7,$8::jsonb,$9::jsonb,'failed','error','PROVIDER_SEND_NOT_FOUND',now(),null,null,gen_random_uuid(),repeat('b',64),$10),
         ($2,$5,$6,$7,$8::jsonb,$9::jsonb,'send_unknown','awaiting',null,null,null,null,gen_random_uuid(),repeat('c',64),$10),
         ($3,$5,$6,$7,$8::jsonb,$9::jsonb,'send_unknown','awaiting',null,null,null,null,gen_random_uuid(),repeat('d',64),$10),
         ($4,$5,$6,$7,$8::jsonb,$9::jsonb,'sent','awaiting',null,null,'provider-request',now(),gen_random_uuid(),repeat('e',64),$10),
         ($11,$5,$6,$7,$8::jsonb,$9::jsonb,'send_unknown','awaiting',null,null,null,null,gen_random_uuid(),repeat('f',64),$10)`,
      [
        operatorRequestId,
        automaticRequestId,
        metadataRequestId,
        sentRequestId,
        orgId,
        propertyId,
        templateId,
        signerSnapshot,
        mergeSnapshot,
        userId,
        metadataMissingLocalRequestId,
      ],
    );

    await setup.query(
      `select public.resolve_esign_send_unknown_not_sent(
        $1,$2,$3,'operator','PROVIDER_SEND_NOT_FOUND',
        '{"acknowledgedFailure":"PROVIDER_SEND_NOT_FOUND","resolutionSource":"operator"}'::jsonb
      )`,
      [orgId, operatorRequestId, userId],
    );
    const operatorAcknowledgedAt = (
      await setup.query<{ updated_at: string }>(
        `select updated_at::text
         from public.esign_requests
         where id=$1`,
        [operatorRequestId],
      )
    ).rows[0].updated_at;
    await setup.query("select pg_sleep(0.01)");
    await setup.query(
      `select public.resolve_esign_send_unknown_not_sent(
        $1,$2,$3,'operator','PROVIDER_SEND_NOT_FOUND',
        '{"acknowledgedFailure":"PROVIDER_SEND_NOT_FOUND","resolutionSource":"operator"}'::jsonb
      )`,
      [orgId, operatorRequestId, userId],
    );
    await setup.query(
      `select public.resolve_esign_send_unknown_not_sent(
        $1,$2,null,'automatic','PROVIDER_SEND_NOT_FOUND',
        '{"positiveControl":"passed","resolutionSource":"automatic"}'::jsonb
      )`,
      [orgId, automaticRequestId],
    );
    await setup.query(
      `select public.attach_esign_request_provider_delivery(
        $1,$2::uuid,'provider-after-timeout','webhook',
        jsonb_build_object(
          'source','dropbox_metadata_sandra_request_id',
          'localRequestId',$2::text,
          'providerRequestId','provider-after-timeout'
        )
      )`,
      [orgId, metadataRequestId],
    );
    await expect(
      setup.query(
        `select public.attach_esign_request_provider_delivery(
          $1,$2,'provider-automatic-missing-local','automatic',
          '{"source":"dropbox_metadata_search_sandra_request_id","providerRequestId":"provider-automatic-missing-local","positiveControl":"passed"}'::jsonb
        )`,
        [orgId, metadataMissingLocalRequestId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      setup.query(
        `select public.attach_esign_request_provider_delivery(
          $1,$2::uuid,'provider-automatic-wrong-local','automatic',
          jsonb_build_object(
            'source','dropbox_metadata_search_sandra_request_id',
            'localRequestId',$3::text,
            'providerRequestId','provider-automatic-wrong-local',
            'positiveControl','passed'
          )
        )`,
        [orgId, metadataMissingLocalRequestId, automaticRequestId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await setup.query(
      `select public.attach_esign_request_provider_delivery(
        $1,$2::uuid,'provider-automatic-local-match','automatic',
        jsonb_build_object(
          'source','dropbox_metadata_search_sandra_request_id',
          'localRequestId',$2::text,
          'providerRequestId','provider-automatic-local-match',
          'positiveControl','passed'
        )
      )`,
      [orgId, metadataMissingLocalRequestId],
    );
    await expect(
      setup.query(
        `select public.attach_esign_request_provider_delivery(
          $1,$2,'provider-missing-local','webhook',
          '{"source":"dropbox_metadata_sandra_request_id","providerRequestId":"provider-missing-local"}'::jsonb
        )`,
        [orgId, metadataMissingLocalRequestId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      setup.query(
        `select public.resolve_esign_send_unknown_not_sent(
          $1,$2,$3,'operator','PROVIDER_SEND_NOT_FOUND',
          '{"acknowledgedFailure":"PROVIDER_SEND_NOT_FOUND"}'::jsonb
        )`,
        [orgId, operatorRequestId, memberId],
      ),
    ).rejects.toMatchObject({ code: "42501" });

    expect(
      (
        await setup.query<{
          id: string;
          delivery_state: string;
          status: string;
          error_message: string | null;
          updated_by: string | null;
        }>(
          `select id,delivery_state,status,error_message,updated_by
           from public.esign_requests
           where id = any($1::uuid[])
           order by id`,
          [[
            operatorRequestId,
            automaticRequestId,
            metadataRequestId,
            metadataMissingLocalRequestId,
          ]],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: operatorRequestId,
          delivery_state: "failed",
          status: "error",
          error_message: "PROVIDER_SEND_NOT_FOUND",
          updated_by: userId,
        }),
        expect.objectContaining({
          id: automaticRequestId,
          delivery_state: "failed",
          status: "error",
          error_message: "PROVIDER_SEND_NOT_FOUND",
          updated_by: null,
        }),
        expect.objectContaining({
          id: metadataRequestId,
          delivery_state: "sent",
          status: "awaiting",
          error_message: null,
          updated_by: null,
        }),
        expect.objectContaining({
          id: metadataMissingLocalRequestId,
          delivery_state: "sent",
          status: "awaiting",
          error_message: null,
          updated_by: null,
        }),
      ]),
    );
    expect(
      (
        await setup.query<{ actor_type: string; actor_id: string | null }>(
          `select actor_type,actor_id
           from public.lead_events
           where event_type='esign_send_not_found_operator'
             and payload->>'request_id'=$1`,
          [operatorRequestId],
        )
      ).rows[0],
    ).toEqual({ actor_type: "user", actor_id: userId });
    expect(
      (
        await setup.query<{ count: string }>(
          `select count(*)::text
           from public.lead_events
           where event_type='esign_send_not_found_operator'
             and payload->>'request_id'=$1`,
          [operatorRequestId],
        )
      ).rows[0],
    ).toEqual({ count: "1" });
    expect(
      (
        await setup.query<{ updated_at: string }>(
          `select updated_at::text
           from public.esign_requests
           where id=$1`,
          [operatorRequestId],
        )
      ).rows[0].updated_at,
    ).toBe(operatorAcknowledgedAt);
    expect(
      (
        await setup.query<{ actor_type: string; actor_id: string | null }>(
          `select actor_type,actor_id
           from public.lead_events
           where event_type='esign_send_not_found_automatic'
             and payload->>'request_id'=$1`,
          [automaticRequestId],
        )
      ).rows[0],
    ).toEqual({ actor_type: "system", actor_id: null });
    expect(
      (
        await setup.query<{ actor_type: string; actor_id: string | null }>(
          `select actor_type,actor_id
           from public.lead_events
           where event_type='esign_send_provider_attached_webhook'
             and payload->>'request_id'=$1`,
          [metadataRequestId],
        )
      ).rows[0],
    ).toEqual({ actor_type: "system", actor_id: null });

    await expect(
      setup.query(
        `select public.resolve_esign_send_unknown_not_sent(
          $1,$2,$3,'operator','PROVIDER_SEND_NOT_FOUND',
          '{"acknowledgedFailure":"PROVIDER_SEND_NOT_FOUND"}'::jsonb
        )`,
        [orgId, sentRequestId, userId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      setup.query(
        `select public.resolve_esign_send_unknown_not_sent(
          $1,$2,$3,'operator','PROVIDER_SEND_NOT_FOUND',
          '{"positiveControl":"missing"}'::jsonb
        )`,
        [orgId, sentRequestId, userId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
