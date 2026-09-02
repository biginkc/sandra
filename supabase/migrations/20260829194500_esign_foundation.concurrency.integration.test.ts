import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  "supabase/migrations/20260829194500_esign_foundation.sql",
  "utf8",
);
const uploadReservationsSql = readFileSync(
  "supabase/migrations/20260830080000_esign_template_upload_reservations.sql",
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
const sellerEmailAuthoritySql = readFileSync(
  "supabase/migrations/20260902010000_esign_dialog_seller_email_authority.sql",
  "utf8",
);
const atomicDisconnectSql = readFileSync(
  "supabase/migrations/20260902074814_esign_atomic_disconnect_state.sql",
  "utf8",
);
const emailBouncedDeliveryStateSql = readFileSync(
  "supabase/migrations/20260902110000_esign_email_bounced_delivery_state.sql",
  "utf8",
);
const emailBounceRecoverySql = readFileSync(
  "supabase/migrations/20260902111000_esign_email_bounce_recovery.sql",
  "utf8",
);
const providerTruthfulLifecycleSql = readFileSync(
  "supabase/migrations/20260902112000_esign_provider_truthful_lifecycle.sql",
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

const bootstrapSql = `
  do $roles$
  begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then
      create role anon;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'authenticated') then
      create role authenticated;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'service_role') then
      create role service_role;
    end if;
  end;
  $roles$;

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
    phone_1 text,
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
`;

async function applyPreDisconnectMigrations(client: Client): Promise<void> {
  await client.query(migrationSql);
  await client.query(uploadReservationsSql);
  await client.query(uploadReservationsSql);
  await client.query(reconciliationFenceSql);
  await client.query(retryReminderFenceSql);
  await client.query(sellerEmailAuthoritySql);
  await client.query(sellerEmailAuthoritySql);
  await client.query(sendUnknownResolutionSql);
  await client.query(sendUnknownResolutionSql);
}

async function applyPost475Migrations(client: Client): Promise<void> {
  await client.query(emailBouncedDeliveryStateSql);
  await client.query(emailBouncedDeliveryStateSql);
  await client.query(emailBounceRecoverySql);
  await client.query(emailBounceRecoverySql);
  await client.query(providerTruthfulLifecycleSql);
  await client.query(providerTruthfulLifecycleSql);
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
  await setup.query(bootstrapSql);
  await applyPreDisconnectMigrations(setup);
  await applyPost475Migrations(setup);
  await setup.query(atomicDisconnectSql);
  await setup.query(atomicDisconnectSql);
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

async function withOrderRehearsal(
  label: string,
  applyOrder: (client: Client) => Promise<void>,
): Promise<void> {
  const orderDatabaseName = `sandra_esign_order_${label}_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`;
  await admin.query(`create database ${orderDatabaseName}`);
  const client = new Client({ connectionString: databaseUrl(orderDatabaseName) });
  try {
    await client.connect();
    await client.query(bootstrapSql);
    await applyPreDisconnectMigrations(client);
    await applyOrder(client);
    expect(
      (
        await client.query<{ allowed: boolean }>(
          "select has_column_privilege('authenticated','public.org_esign_integrations','disconnect_pending_at','select') as allowed",
        )
      ).rows[0],
    ).toEqual({ allowed: true });
    expect(
      (
        await client.query<{ proname: string }>(
          "select proname from pg_proc where proname='esign_require_template_management_capability'",
        )
      ).rowCount,
    ).toBe(1);
  } finally {
    await client.end().catch(() => undefined);
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname=$1 and pid <> pg_backend_pid()",
      [orderDatabaseName],
    );
    await admin.query(`drop database if exists ${orderDatabaseName} with (force)`);
  }
}

describe("eSign disconnect migration deploy order compatibility", () => {
  it("applies twice when #475 migrations land before or after disconnect", async () => {
    await withOrderRehearsal("after475", async (client) => {
      await applyPost475Migrations(client);
      await client.query(atomicDisconnectSql);
      await client.query(atomicDisconnectSql);
    });
    await withOrderRehearsal("before475", async (client) => {
      await client.query(atomicDisconnectSql);
      await client.query(atomicDisconnectSql);
      await applyPost475Migrations(client);
    });
  }, 120_000);
});

describe("eSign foundation production lease contention", () => {
  it("turns a Dropbox Sign email bounce into same-request signer correction", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    const signerId = crypto.randomUUID();
    const consumerId = crypto.randomUUID();
    const providerRequestId = `provider-request-${requestId}`;
    const oldSignatureId = `signature-old-${signerId}`;
    const newSignatureId = `signature-new-${signerId}`;
    const leaseId = crypto.randomUUID();
    const claimToken = crypto.randomUUID();
    const bounceAt = "2026-09-02T06:00:00.000Z";

    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.contacts (id,org_id,email) values ($1,$2,'old-contact@example.com')",
      [contactId, orgId],
    );
    await setup.query(
      "insert into public.properties (id,org_id,homeowner_contact_id) values ($1,$2,$3)",
      [propertyId, orgId, contactId],
    );
    await setup.query(
      `insert into public.webhook_consumers (
         id,org_id,name,secret_hash,consumer_type
       ) values ($1,$2,$3,repeat('a',64),'esign_provider')`,
      [consumerId, orgId, `esign-${consumerId}`],
    );
    await setup.query(
      `insert into public.org_esign_integrations (
         org_id,api_key_encrypted,api_key_last_four,client_id,
         callback_consumer_id,callback_verified_at,sending_enabled,
         provider_account_id,
         connected_by,updated_by
       ) values ($1,'\\x00','1234','client-1',$2,now(),true,'account-1',$3,$3)`,
      [orgId, consumerId, userId],
    );
    await setup.query(
      `insert into public.esign_template_staging_sources (
         id,org_id,storage_path,source_filename,source_size_bytes,
         content_type,source_sha256,cleanup_outcome,cleanup_attempted_at,created_by
       ) values (
         $1,$2,$3,'contract.pdf',1024,'application/pdf',repeat('b',64),
         'deleted',now(),$4
       )`,
      [sourceId, orgId, `${orgId}/${sourceId}.pdf`, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,
         merge_field_names,sign_template_id,staging_source_id,
         source_filename,source_size_bytes,source_content_type,source_sha256,
         staging_path,provider_account_id,finalized_at,lifecycle_state,
         provider_create_state,provider_create_claim_token_hash,
         provider_create_claimed_at,provider_create_invocation_started_at,
         created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         $6,$3,'contract.pdf',1024,'application/pdf',
         repeat('b',64),$4,'account-1',now(),'finalized',
         'attached',repeat('9',64),now(),now(),$5,$5
       )`,
      [
        templateId,
        orgId,
        sourceId,
        `${orgId}/${sourceId}.pdf`,
        userId,
        `provider-template-${templateId}`,
      ],
    );
    await setup.query(
      `insert into public.esign_requests (
         id,org_id,property_id,template_id,signer_snapshot,
         merge_value_snapshot,status,delivery_state,sign_request_id,
         details_url,send_intent_id,payload_hash,sent_at,created_by,
         claimed_homeowner_contact_id
       ) values (
         $1,$2,$3,$4,
         '[{"role":"Seller","order":0,"name":"Seller Owner","emailAddress":"bad@example.invalid"}]'::jsonb,
         '{"seller_name":"Seller Owner","property_address":"123 Main St","offer_price":"$1","closing_date":"2026-09-30","earnest_money":"$1"}'::jsonb,
         'awaiting','sent',$5,'https://app.hellosign.com/home/manage?guid=provider-request',
         $6,repeat('c',64),now(),$7,$8
       )`,
      [
        requestId,
        orgId,
        propertyId,
        templateId,
        providerRequestId,
        crypto.randomUUID(),
        userId,
        contactId,
      ],
    );
    await setup.query(
      `insert into public.esign_request_signers (
         id,org_id,request_id,role_name,signer_order,signer_name,
         signer_email,provider_signature_id,status
       ) values ($1,$2,$3,'Seller',0,'Seller Owner',$4,$5,'awaiting')`,
      [signerId, orgId, requestId, "bad@example.invalid", oldSignatureId],
    );

    const receipt = await setup.query<{ receipt_id: string }>(
      `select receipt_id
       from public.claim_esign_webhook_receipt(
         $1,$2,repeat('d',64),repeat('e',64),repeat('f',64),
         'signature_request_email_bounce',$3,$4,$5,
         jsonb_build_object(
           'event_time', extract(epoch from $5::timestamptz)::bigint::text,
           'event_type', 'signature_request_email_bounce',
           'sign_request_id', $3::text,
           'related_signature_id', $4::text,
           'reported_for_app_id', 'client-1'
         ),
         now(),$6,300
       )`,
      [orgId, consumerId, providerRequestId, oldSignatureId, bounceAt, leaseId],
    );

    const bounced = await setup.query<{ outcome: string; status: string }>(
      `select * from public.apply_esign_email_bounce_delivery_decision(
         $1,$2,$3,$4,'awaiting',$5
       )`,
      [orgId, requestId, receipt.rows[0].receipt_id, leaseId, bounceAt],
    );
    expect(bounced.rows[0]).toEqual({ outcome: "applied", status: "error" });

    const bouncedRequest = await setup.query<{
      status: string;
      delivery_state: string;
      sign_request_id: string;
      error_message: string;
    }>(
      `select status,delivery_state,sign_request_id,error_message
       from public.esign_requests where id=$1`,
      [requestId],
    );
    expect(bouncedRequest.rows[0]).toEqual({
      status: "error",
      delivery_state: "email_bounced",
      sign_request_id: providerRequestId,
      error_message: "PROVIDER_EMAIL_BOUNCE",
    });

    const disconnect = await setup.query<{
      disconnected: boolean;
      sending_enabled: boolean;
      credentials_present: boolean;
      disconnect_pending: boolean;
      message: string;
    }>("select * from public.disconnect_org_esign_integration($1,$2)", [
      orgId,
      userId,
    ]);
    expect(disconnect.rows[0]).toMatchObject({
      disconnected: false,
      sending_enabled: false,
      credentials_present: true,
      disconnect_pending: true,
    });
    expect(disconnect.rows[0].message).toMatch(/1 signature request/i);
    expect(
      (
        await setup.query<{
          sending_enabled: boolean;
          credentials_present: boolean;
          disconnect_pending: boolean;
        }>(
          `select sending_enabled,
             api_key_encrypted is not null as credentials_present,
             disconnect_pending_at is not null as disconnect_pending
           from public.org_esign_integrations
           where org_id=$1`,
          [orgId],
        )
      ).rows[0],
    ).toEqual({
      sending_enabled: false,
      credentials_present: true,
      disconnect_pending: true,
    });

    const claim = await setup.query<{
      outcome: string;
      provider_request_id: string;
      provider_signature_id: string;
    }>(
      `select outcome,provider_request_id,provider_signature_id
       from public.claim_esign_bounced_signer_email_update(
         $1,$2,$3,$4,'seller-fixed@example.com',$5
       )`,
      [orgId, requestId, signerId, userId, claimToken],
    );
    expect(claim.rows[0]).toEqual({
      outcome: "claimed",
      provider_request_id: providerRequestId,
      provider_signature_id: oldSignatureId,
    });

    const providerSignatures = JSON.stringify([{
      signatureId: newSignatureId,
      role: "Seller",
      name: "Seller Owner",
      emailAddress: "seller-fixed@example.com",
      order: 0,
      statusCode: "signed",
      signedAt: 1788331417,
    }]);
    const webhookBeforeFinalizerAt = "2026-09-02T06:00:30.000Z";
    const webhookBeforeFinalizerLeaseId = crypto.randomUUID();
    const webhookBeforeFinalizerReceipt = await setup.query<{
      receipt_id: string;
      lease_id: string;
    }>(
      `select receipt_id,lease_id
       from public.claim_esign_webhook_receipt(
         $1,$2,repeat('1',64),repeat('2',64),repeat('3',64),
         'signature_request_viewed',$3,$4,$5,
         jsonb_build_object(
           'event_time', extract(epoch from $5::timestamptz)::bigint::text,
           'event_type', 'signature_request_viewed',
           'sign_request_id', $3::text,
           'related_signature_id', $4::text,
           'reported_for_app_id', 'client-1'
         ),
         now(),$6,300
       )`,
      [
        orgId,
        consumerId,
        providerRequestId,
        newSignatureId,
        webhookBeforeFinalizerAt,
        webhookBeforeFinalizerLeaseId,
      ],
    );
    expect(
      (
        await setup.query<{ outcome: string }>(
          `select outcome from public.reconcile_esign_webhook_provider_signers(
             $1,$2,$3,$4,$5,$6::jsonb,$7
           )`,
          [
            orgId,
            requestId,
            webhookBeforeFinalizerReceipt.rows[0].receipt_id,
            webhookBeforeFinalizerReceipt.rows[0].lease_id,
            webhookBeforeFinalizerAt,
            providerSignatures,
            null,
          ],
        )
      ).rows[0].outcome,
    ).toBe("applied");
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [
        webhookBeforeFinalizerReceipt.rows[0].receipt_id,
        webhookBeforeFinalizerReceipt.rows[0].lease_id,
      ],
    );
    expect(
      (
        await setup.query<{
          signer_email: string;
          provider_signature_id: string;
          email_update_claim_token: string | null;
          email_update_claim_email: string | null;
          contact_email: string | null;
        }>(
          `select signer.signer_email,
             signer.provider_signature_id,
             signer.email_update_claim_token::text,
             signer.email_update_claim_email,
             contact.email as contact_email
           from public.esign_request_signers signer
           join public.contacts contact on contact.id=$4 and contact.org_id=$1
           where signer.org_id=$1 and signer.request_id=$2 and signer.id=$3`,
          [orgId, requestId, signerId, contactId],
        )
      ).rows[0],
    ).toEqual({
      signer_email: "seller-fixed@example.com",
      provider_signature_id: newSignatureId,
      email_update_claim_token: claimToken,
      email_update_claim_email: "seller-fixed@example.com",
      contact_email: "old-contact@example.com",
    });

    const finalized = await setup.query<{ result: string }>(
      `select public.finalize_esign_bounced_signer_email_update(
         $1,$2,$3,$4,$5
       ) as result`,
      [orgId, requestId, signerId, claimToken, newSignatureId],
    );
    expect(finalized.rows[0].result).toBe("applied");
    const duplicateFinalize = await setup.query<{ result: string }>(
      `select public.finalize_esign_bounced_signer_email_update(
         $1,$2,$3,$4,$5
       ) as result`,
      [orgId, requestId, signerId, claimToken, newSignatureId],
    );
    expect(duplicateFinalize.rows[0].result).toBe("lease_lost");

    const finalRows = await setup.query<{
      request_count: string;
      request_status: string;
      delivery_state: string;
      sign_request_id: string;
      signer_email: string;
      provider_signature_id: string;
      signer_status: string;
      contact_email: string;
    }>(
      `select
         (select count(*)::text from public.esign_requests where org_id=$1) as request_count,
         request.status::text as request_status,
         request.delivery_state::text as delivery_state,
         request.sign_request_id,
         signer.signer_email,
         signer.provider_signature_id,
         signer.status as signer_status,
         contact.email as contact_email
       from public.esign_requests request
       join public.esign_request_signers signer
         on signer.request_id=request.id and signer.org_id=request.org_id
       join public.contacts contact on contact.id=$4 and contact.org_id=$1
       where request.id=$2 and signer.id=$3`,
      [orgId, requestId, signerId, contactId],
    );
    expect(finalRows.rows[0]).toEqual({
      request_count: "1",
      request_status: "awaiting",
      delivery_state: "sent",
      sign_request_id: providerRequestId,
      signer_email: "seller-fixed@example.com",
      provider_signature_id: newSignatureId,
      signer_status: "awaiting",
      contact_email: "seller-fixed@example.com",
    });

    const events = await setup.query<{ event_type: string; payload: unknown }>(
      `select event_type,payload
       from public.lead_events
       where org_id=$1 and property_id=$2
       order by event_type`,
      [orgId, propertyId],
    );
    expect(events.rows.map((event) => event.event_type)).toEqual([
      "esign_email_bounced",
      "esign_email_bounced_resend",
    ]);
    expect(JSON.stringify(events.rows.map((event) => event.payload))).not.toMatch(
      /bad@example|seller-fixed@example/i,
    );

    const claimLifecycle = async (
      eventType: string,
      eventAt: string,
      relatedSignatureId: string | null,
    ) => {
      const lease = crypto.randomUUID();
      const receipt = await setup.query<{ receipt_id: string; lease_id: string }>(
        `select receipt_id,lease_id
         from public.claim_esign_webhook_receipt(
           $1,$2,repeat('d',64),encode(sha256(($3 || coalesce($4,''))::bytea),'hex'),
           repeat('f',64),$3,$5,$4,$6,
           jsonb_build_object(
             'event_time', extract(epoch from $6::timestamptz)::bigint::text,
             'event_type', $3::text,
             'sign_request_id', $5::text,
             'related_signature_id', $4::text,
             'reported_for_app_id', 'client-1'
           ),
           now(),$7,300
         )`,
        [
          orgId,
          consumerId,
          eventType,
          relatedSignatureId,
          providerRequestId,
          eventAt,
          lease,
        ],
      );
      return receipt.rows[0];
    };

    const viewedAt = "2026-09-02T06:01:00.000Z";
    const viewedReceipt = await claimLifecycle(
      "signature_request_viewed",
      viewedAt,
      newSignatureId,
    );
    expect(
      (
        await setup.query<{ outcome: string }>(
          `select outcome from public.reconcile_esign_webhook_provider_signers(
             $1,$2,$3,$4,$5,$6::jsonb,$7
           )`,
          [
            orgId,
            requestId,
            viewedReceipt.receipt_id,
            viewedReceipt.lease_id,
            viewedAt,
            providerSignatures,
            null,
          ],
        )
      ).rows[0].outcome,
    ).toMatch(/applied|already_reconciled/);
    expect(
      (
        await setup.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'awaiting','viewed',$5,'esign_viewed',$6::jsonb
           )`,
          [
            orgId,
            requestId,
            viewedReceipt.receipt_id,
            viewedReceipt.lease_id,
            viewedAt,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "applied", status: "viewed" });
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [viewedReceipt.receipt_id, viewedReceipt.lease_id],
    );

    const signedAt = "2026-09-02T06:02:00.000Z";
    const signedReceipt = await claimLifecycle(
      "signature_request_signed",
      signedAt,
      newSignatureId,
    );
    expect(
      (
        await setup.query<{ outcome: string }>(
          `select outcome from public.reconcile_esign_webhook_provider_signers(
             $1,$2,$3,$4,$5,$6::jsonb,$7
           )`,
          [
            orgId,
            requestId,
            signedReceipt.receipt_id,
            signedReceipt.lease_id,
            signedAt,
            providerSignatures,
            newSignatureId,
          ],
        )
      ).rows[0].outcome,
    ).toMatch(/applied|already_reconciled/);
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [signedReceipt.receipt_id, signedReceipt.lease_id],
    );

    const allSignedAt = "2026-09-02T06:03:00.000Z";
    const allSignedReceipt = await claimLifecycle(
      "signature_request_all_signed",
      allSignedAt,
      null,
    );
    expect(
      (
        await setup.query<{ outcome: string }>(
          `select outcome from public.reconcile_esign_webhook_provider_signers(
             $1,$2,$3,$4,$5,$6::jsonb,$7
           )`,
          [
            orgId,
            requestId,
            allSignedReceipt.receipt_id,
            allSignedReceipt.lease_id,
            allSignedAt,
            providerSignatures,
            null,
          ],
        )
      ).rows[0].outcome,
    ).toMatch(/applied|already_reconciled/);
    expect(
      (
        await setup.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'viewed','signed',$5,'esign_signed',$6::jsonb
           )`,
          [
            orgId,
            requestId,
            allSignedReceipt.receipt_id,
            allSignedReceipt.lease_id,
            allSignedAt,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "applied", status: "signed" });
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [allSignedReceipt.receipt_id, allSignedReceipt.lease_id],
    );

    const downloadableAt = "2026-09-02T06:04:00.000Z";
    const downloadableReceipt = await claimLifecycle(
      "signature_request_downloadable",
      downloadableAt,
      null,
    );
    expect(
      (
        await setup.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'signed','signed',$5,'esign_signed',$6::jsonb
           )`,
          [
            orgId,
            requestId,
            downloadableReceipt.receipt_id,
            downloadableReceipt.lease_id,
            downloadableAt,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "terminal_ignored", status: "signed" });
    const storagePath = `${orgId}/${propertyId}/esign/${requestId}/signed.pdf`;
    await setup.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('lead-files',$1,'{"mimetype":"application/pdf","size":1024}')`,
      [storagePath],
    );
    const leadFileId = crypto.randomUUID();
    expect(
      (
        await setup.query<{ outcome: string; lead_file_id: string }>(
          `select * from public.reconcile_esign_completed_signed_artifact(
             $1,$2,$3,'lead-files',$4,'application/pdf',1024,
             'esign_signed_pdf_ready',$5::jsonb
           )`,
          [
            orgId,
            requestId,
            leadFileId,
            storagePath,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({
      outcome: "applied",
      lead_file_id: leadFileId,
    });
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [downloadableReceipt.receipt_id, downloadableReceipt.lease_id],
    );

    expect(
      (
        await setup.query<{
          request_status: string;
          delivery_state: string;
          signed_pdf_path: string | null;
          signer_status: string;
          contact_email: string;
          lead_files_count: string;
        }>(
          `select request.status::text as request_status,
             request.delivery_state::text as delivery_state,
             request.signed_pdf_path,
             signer.status as signer_status,
             contact.email as contact_email,
             (select count(*)::text from public.lead_files
              where org_id=$1 and source_request_id=$2) as lead_files_count
           from public.esign_requests request
           join public.esign_request_signers signer
             on signer.org_id=request.org_id and signer.request_id=request.id
           join public.contacts contact on contact.id=$3 and contact.org_id=$1
           where request.id=$2`,
          [orgId, requestId, contactId],
        )
      ).rows[0],
    ).toEqual({
      request_status: "signed",
      delivery_state: "sent",
      signed_pdf_path: storagePath,
      signer_status: "signed",
      contact_email: "seller-fixed@example.com",
      lead_files_count: "1",
    });
  });

  it("repairs the observed provider-updated signed request without stale signature-id failures", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const requestId = "87e9726a-c09a-4f9b-aa20-eccae6d3b60e";
    const consumerId = crypto.randomUUID();
    const providerRequestId = "47bde6019bf33ab33dc0cf8f862fe37a1476e42a";
    const oldSignatureId = "3d10fd2cc296c276bae2ed4e28ca7195";
    const newSignatureId = "bb67df41911f964aa66f488bd2878cbd";
    const eventAt = "2026-09-02T06:43:37.000Z";
    const providerSignatures = JSON.stringify([{
      signatureId: newSignatureId,
      role: "Seller",
      name: "eSign QA A PRIMARY_E2E",
      emailAddress: "jarrad.henry@gmail.com",
      order: 0,
      statusCode: "signed",
      signedAt: 1788331417,
    }]);

    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.contacts (id,org_id,email) values ($1,$2,'e2e-test@bmhgroupkc.com')",
      [contactId, orgId],
    );
    await setup.query(
      "insert into public.properties (id,org_id,homeowner_contact_id) values ($1,$2,$3)",
      [propertyId, orgId, contactId],
    );
    await setup.query(
      `insert into public.webhook_consumers (
         id,org_id,name,secret_hash,consumer_type
       ) values ($1,$2,$3,repeat('a',64),'esign_provider')`,
      [consumerId, orgId, `esign-${consumerId}`],
    );
    await setup.query(
      `insert into public.org_esign_integrations (
         org_id,api_key_encrypted,api_key_last_four,client_id,
         callback_consumer_id,callback_verified_at,sending_enabled,
         provider_account_id,
         connected_by,updated_by
       ) values ($1,'\\x00','1234','client-1',$2,now(),true,'account-1',$3,$3)`,
      [orgId, consumerId, userId],
    );
    await setup.query(
      `insert into public.esign_template_staging_sources (
         id,org_id,storage_path,source_filename,source_size_bytes,
         content_type,source_sha256,created_by
       ) values ($1,$2,$3,'contract.pdf',1024,'application/pdf',repeat('b',64),$4)`,
      [sourceId, orgId, `${orgId}/${sourceId}.pdf`, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,
         merge_field_names,sign_template_id,staging_source_id,
         source_filename,source_size_bytes,source_content_type,source_sha256,
         staging_path,provider_account_id,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         'provider-template-1',$3,'contract.pdf',1024,'application/pdf',
         repeat('b',64),$4,'account-1',now(),'finalized',$5,$5
       )`,
      [templateId, orgId, sourceId, `${orgId}/${sourceId}.pdf`, userId],
    );
    await setup.query(
      `insert into public.esign_requests (
         id,org_id,property_id,template_id,signer_snapshot,
         merge_value_snapshot,status,delivery_state,sign_request_id,
         details_url,send_intent_id,payload_hash,sent_at,completed_at,
         error_message,created_by,claimed_homeowner_contact_id
       ) values (
         $1,$2,$3,$4,
         '[{"role":"Seller","order":0,"name":"eSign QA A PRIMARY_E2E","emailAddress":"e2e-test@bmhgroupkc.com"}]'::jsonb,
         '{"seller_name":"eSign QA A PRIMARY_E2E","property_address":"123 Main St","offer_price":"$1","closing_date":"2026-09-30","earnest_money":"$1"}'::jsonb,
         'error','sent',$5,'https://app.hellosign.com/home/manage?guid=provider-request',
         $6,repeat('c',64),now(),'2026-09-02T05:55:30.000Z',
         'PROVIDER_ERROR',$7,$8
       )`,
      [
        requestId,
        orgId,
        propertyId,
        templateId,
        providerRequestId,
        crypto.randomUUID(),
        userId,
        contactId,
      ],
    );
    await setup.query(
      `insert into public.esign_request_signers (
         org_id,request_id,role_name,signer_order,signer_name,
         signer_email,provider_signature_id,status
       ) values ($1,$2,'Seller',0,'eSign QA A PRIMARY_E2E',$3,$4,'error')`,
      [orgId, requestId, "e2e-test@bmhgroupkc.com", oldSignatureId],
    );

    const claim = async (
      eventType: string,
      relatedSignatureId: string | null,
      leaseId = crypto.randomUUID(),
    ) => {
      const claimed = await setup.query<{ receipt_id: string; lease_id: string }>(
        `select receipt_id,lease_id
         from public.claim_esign_webhook_receipt(
           $1,$2,repeat('d',64),encode(sha256(($3 || coalesce($4,''))::bytea),'hex'),
           repeat('f',64),$3,$5,$4,$6,
           jsonb_build_object(
             'event_time', extract(epoch from $6::timestamptz)::bigint::text,
             'event_type', $3::text,
             'sign_request_id', $5::text,
             'related_signature_id', $4::text,
             'reported_for_app_id', 'client-1'
           ),
           now(),$7,300
         )`,
        [
          orgId,
          consumerId,
          eventType,
          relatedSignatureId,
          providerRequestId,
          eventAt,
          leaseId,
        ],
      );
      return claimed.rows[0];
    };

    const signerReceipt = await claim(
      "signature_request_signed",
      newSignatureId,
    );
    expect(
      (
        await setup.query<{ outcome: string }>(
          `select outcome from public.reconcile_esign_webhook_provider_signers(
             $1,$2,$3,$4,$5,$6::jsonb,$7
           )`,
          [
            orgId,
            requestId,
            signerReceipt.receipt_id,
            signerReceipt.lease_id,
            eventAt,
            providerSignatures,
            newSignatureId,
          ],
        )
      ).rows[0].outcome,
    ).toBe("applied");
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [signerReceipt.receipt_id, signerReceipt.lease_id],
    );

    const allSignedReceipt = await claim(
      "signature_request_all_signed",
      null,
    );
    expect(
      (
        await setup.query<{ outcome: string; status: string }>(
          `select * from public.apply_esign_webhook_status_decision(
             $1,$2,$3,$4,'error','signed',$5,'esign_signed',$6::jsonb
           )`,
          [
            orgId,
            requestId,
            allSignedReceipt.receipt_id,
            allSignedReceipt.lease_id,
            eventAt,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({ outcome: "applied", status: "signed" });
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [allSignedReceipt.receipt_id, allSignedReceipt.lease_id],
    );

    const downloadableReceipt = await claim(
      "signature_request_downloadable",
      null,
    );
    const storagePath = `${orgId}/${propertyId}/esign/${requestId}/signed.pdf`;
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'processed',null)",
      [downloadableReceipt.receipt_id, downloadableReceipt.lease_id],
    );
    expect(
      (
        await setup.query<{ signed_pdf_path: string | null; lead_files_count: string }>(
          `select request.signed_pdf_path,
             (select count(*)::text from public.lead_files where source_request_id=$1)
               as lead_files_count
           from public.esign_requests request where request.id=$1`,
          [requestId],
        )
      ).rows[0],
    ).toEqual({
      signed_pdf_path: null,
      lead_files_count: "0",
    });

    await setup.query(
      `insert into storage.objects (bucket_id, name, metadata)
       values ('lead-files',$1,'{"mimetype":"application/pdf","size":1024}')`,
      [storagePath],
    );
    const repairedLeadFileId = crypto.randomUUID();
    expect(
      (
        await setup.query<{ outcome: string; lead_file_id: string }>(
          `select * from public.reconcile_esign_completed_signed_artifact(
             $1,$2,$3,'lead-files',$4,'application/pdf',1024,
             'esign_signed_pdf_ready',$5::jsonb
           )`,
          [
            orgId,
            requestId,
            repairedLeadFileId,
            storagePath,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({
      outcome: "applied",
      lead_file_id: repairedLeadFileId,
    });
    expect(
      (
        await setup.query<{ outcome: string; lead_file_id: string }>(
          `select * from public.reconcile_esign_completed_signed_artifact(
             $1,$2,$3,'lead-files',$4,'application/pdf',1024,
             'esign_signed_pdf_ready',$5::jsonb
           )`,
          [
            orgId,
            requestId,
            crypto.randomUUID(),
            storagePath,
            JSON.stringify({ template_title: "Purchase agreement" }),
          ],
        )
      ).rows[0],
    ).toEqual({
      outcome: "already_linked",
      lead_file_id: repairedLeadFileId,
    });

    const repaired = await setup.query<{
      request_status: string;
      delivery_state: string;
      error_message: string | null;
      signed_pdf_path: string | null;
      lead_files_count: string;
      signer_email: string;
      provider_signature_id: string;
      signer_status: string;
      signer_signed: boolean;
    }>(
      `select
         request.status::text as request_status,
         request.delivery_state::text as delivery_state,
         request.error_message,
         request.signed_pdf_path,
         (select count(*)::text from public.lead_files file
          where file.org_id=$1 and file.source_request_id=$2) as lead_files_count,
         signer.signer_email,
         signer.provider_signature_id,
         signer.status as signer_status,
         signer.signed_at is not null as signer_signed
       from public.esign_requests request
       join public.esign_request_signers signer
         on signer.org_id=request.org_id and signer.request_id=request.id
       where request.org_id=$1 and request.id=$2`,
      [orgId, requestId],
    );
    expect(repaired.rows[0]).toEqual({
      request_status: "signed",
      delivery_state: "sent",
      error_message: null,
      signed_pdf_path: storagePath,
      lead_files_count: "1",
      signer_email: "jarrad.henry@gmail.com",
      provider_signature_id: newSignatureId,
      signer_status: "signed",
      signer_signed: true,
    });
  });

  it("does not deadlock a contact-first writer while claiming a request", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.contacts (id,org_id,email) values ($1,$2,'canonical@example.com')",
      [contactId, orgId],
    );
    await setup.query(
      "insert into public.properties (id,org_id,homeowner_contact_id) values ($1,$2,$3)",
      [propertyId, orgId, contactId],
    );
    await setup.query(
      `select public.upsert_org_esign_integration(
         $1,'synthetic-api-key','-key','synthetic-client','account-a',
         repeat('a',64),$2,'synthetic-encryption-key'
       )`,
      [orgId, userId],
    );
    await setup.query(
      `update public.org_esign_integrations
       set callback_verified_at=now(),sending_enabled=true where org_id=$1`,
      [orgId],
    );
    await setup.query(
      `insert into public.esign_template_staging_sources (
         id,org_id,storage_path,source_filename,source_size_bytes,
         content_type,source_sha256,created_by
       ) values ($1,$2,($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf',
         'source.pdf',1024,'application/pdf',repeat('b',64),$3)`,
      [sourceId, orgId, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,
         sign_template_id,provider_account_id,staging_source_id,source_filename,
         source_size_bytes,source_content_type,source_sha256,staging_path,
         finalized_at,lifecycle_state,created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         ($1::uuid)::text,'account-a',$3,'source.pdf',1024,'application/pdf',
         repeat('b',64),($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',
         now(),'finalized',$4,$4
       )`,
      [templateId, orgId, sourceId, userId],
    );

    const contactFirst = new Client({
      connectionString: isolatedUrl,
      application_name: "contact_first_writer",
    });
    const requestClaim = new Client({
      connectionString: isolatedUrl,
      application_name: "esign_request_claim",
    });
    await Promise.all([contactFirst.connect(), requestClaim.connect()]);
    await Promise.all([
      setServiceRole(contactFirst),
      setServiceRole(requestClaim),
    ]);
    try {
      await contactFirst.query("begin");
      await contactFirst.query(
        "select 1 from public.contacts where id=$1 for update",
        [contactId],
      );
      const claimPromise = requestClaim.query<{ outcome: string }>(
        `select outcome from public.create_esign_request(
           $1,$2,$3,$4::jsonb,$5::jsonb,$6,repeat('c',64),null,$7
         )`,
        [
          orgId,
          propertyId,
          templateId,
          JSON.stringify([
            {
              role: "Seller",
              order: 0,
              name: "Seller Owner",
              emailAddress: "dialog@example.com",
            },
          ]),
          JSON.stringify({
            seller_name: "Seller Owner",
            property_address: "123 Test",
            offer_price: "1",
            closing_date: "2026-09-30",
            earnest_money: "1",
          }),
          crypto.randomUUID(),
          userId,
        ],
      );

      await expect(
        Promise.race([
          claimPromise.then(
            (value) => ({ state: "resolved" as const, value }),
            (error: unknown) => ({ state: "rejected" as const, error }),
          ),
          new Promise<{ state: "pending" }>((resolve) =>
            setTimeout(() => resolve({ state: "pending" }), 250),
          ),
        ]),
      ).resolves.toMatchObject({ state: "pending" });

      await contactFirst.query(
        "update public.properties set homeowner_contact_id=$2 where id=$1",
        [propertyId, contactId],
      );
      await contactFirst.query("commit");
      await expect(claimPromise).resolves.toMatchObject({
        rows: [{ outcome: "created" }],
      });
    } finally {
      await contactFirst.query("rollback").catch(() => undefined);
      await Promise.all([contactFirst.end(), requestClaim.end()]);
    }
  });

  it("does not deadlock a contact-first writer while reconciling provider delivery", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.contacts (id,org_id,email) values ($1,$2,'canonical@example.com')",
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
       ) values ($1,$2,($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf',
         'source.pdf',1024,'application/pdf',repeat('b',64),$3)`,
      [sourceId, orgId, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,
         sign_template_id,provider_account_id,staging_source_id,source_filename,
         source_size_bytes,source_content_type,source_sha256,staging_path,
         finalized_at,lifecycle_state,created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         ($1::uuid)::text,'account-a',$3,'source.pdf',1024,'application/pdf',
         repeat('b',64),($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',
         now(),'finalized',$4,$4
       )`,
      [templateId, orgId, sourceId, userId],
    );
    await setup.query(
      `insert into public.esign_requests (
         id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,
         delivery_state,send_intent_id,payload_hash,claimed_homeowner_contact_id,
         created_by
       ) values (
         $1,$2,$3,$4,
         '[{"role":"Seller","order":0,"name":"Seller Owner","emailAddress":"dialog@example.com"}]',
         '{"seller_name":"Seller Owner","property_address":"123 Test","offer_price":"1","closing_date":"2026-09-30","earnest_money":"1"}',
         'sending',gen_random_uuid(),repeat('d',64),$5,$6
       )`,
      [requestId, orgId, propertyId, templateId, contactId, userId],
    );
    await setup.query(
      `insert into public.esign_request_signers (
         org_id,request_id,role_name,signer_order,signer_name,signer_email
       ) values ($1,$2,'Seller',0,'Seller Owner','dialog@example.com')`,
      [orgId, requestId],
    );

    const contactFirst = new Client({
      connectionString: isolatedUrl,
      application_name: "contact_first_writer",
    });
    const deliveryReconcile = new Client({
      connectionString: isolatedUrl,
      application_name: "esign_delivery_reconcile",
    });
    await Promise.all([contactFirst.connect(), deliveryReconcile.connect()]);
    await Promise.all([
      setServiceRole(contactFirst),
      setServiceRole(deliveryReconcile),
    ]);
    try {
      await contactFirst.query("begin");
      await contactFirst.query(
        "select 1 from public.contacts where id=$1 for update",
        [contactId],
      );
      const reconcilePromise = deliveryReconcile.query(
        `select public.reconcile_esign_request_delivery(
           $1,$2,'provider-request','https://app.hellosign.com/details',
           '[{"role":"Seller","order":0,"name":"Seller Owner","emailAddress":"dialog@example.com","signatureId":"signature-1"}]'::jsonb
         )`,
        [orgId, requestId],
      );

      await expect(
        Promise.race([
          reconcilePromise.then(
            (value) => ({ state: "resolved" as const, value }),
            (error: unknown) => ({ state: "rejected" as const, error }),
          ),
          new Promise<{ state: "pending" }>((resolve) =>
            setTimeout(() => resolve({ state: "pending" }), 250),
          ),
        ]),
      ).resolves.toMatchObject({ state: "pending" });

      await contactFirst.query(
        "update public.properties set homeowner_contact_id=$2 where id=$1",
        [propertyId, contactId],
      );
      await contactFirst.query("commit");
      await expect(reconcilePromise).resolves.toBeDefined();
      await expect(
        setup.query<{ delivery_state: string; email: string | null }>(
          `select request.delivery_state, contact.email
           from public.esign_requests request
           join public.contacts contact
             on contact.id = request.claimed_homeowner_contact_id
            and contact.org_id = request.org_id
           where request.id=$1 and request.org_id=$2`,
          [requestId, orgId],
        ),
      ).resolves.toMatchObject({
        rows: [{ delivery_state: "sent", email: "dialog@example.com" }],
      });
    } finally {
      await contactFirst.query("rollback").catch(() => undefined);
      await Promise.all([contactFirst.end(), deliveryReconcile.end()]);
    }
  });

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
         sign_template_id,provider_account_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         ($1::uuid)::text,'account-a',$3::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
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
         $1,'synthetic-api-key','-key','synthetic-client','account-a',
         repeat('a',64),$2,'synthetic-encryption-key'
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

  it("preserves callback ingestion and credentials when disconnect is requested with in-flight requests", async () => {
    const orgId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    const contactId = crypto.randomUUID();
    const propertyId = crypto.randomUUID();
    const sourceId = crypto.randomUUID();
    const templateId = crypto.randomUUID();
    const sendingRequestId = crypto.randomUUID();
    const inFlightRequestId = crypto.randomUUID();
    const leaseId = crypto.randomUUID();
    const eventAt = "2026-09-02T12:00:00.000Z";
    const signerSnapshot = JSON.stringify([
      {
        role: "Seller",
        name: "Seller Owner",
        emailAddress: "pending-disconnect@example.com",
        order: 0,
      },
    ]);
    const mergeSnapshot = JSON.stringify({
      seller_name: "Seller Owner",
      property_address: "106 eSign QA St",
      offer_price: "$125,000",
      closing_date: "2026-09-30",
      earnest_money: "$1,000",
    });

    await setServiceRole(setup);
    await setup.query("insert into auth.users values ($1)", [userId]);
    await setup.query("insert into public.organizations values ($1)", [orgId]);
    await setup.query(
      "insert into public.memberships (user_id,org_id,role) values ($1,$2,'owner')",
      [userId, orgId],
    );
    await setup.query(
      "insert into public.contacts (id,org_id,email) values ($1,$2,'pending-disconnect@example.com')",
      [contactId, orgId],
    );
    await setup.query(
      "insert into public.properties (id,org_id,homeowner_contact_id) values ($1,$2,$3)",
      [propertyId, orgId, contactId],
    );
    await setup.query(
      `select public.upsert_org_esign_integration(
         $1,'synthetic-api-key','-key','synthetic-client','account-a',
         repeat('a',64),$2,'synthetic-encryption-key'
       )`,
      [orgId, userId],
    );
    await setup.query(
      `update public.org_esign_integrations
       set callback_verified_at=now(),sending_enabled=true
       where org_id=$1`,
      [orgId],
    );
    const consumerId = (
      await setup.query<{ callback_consumer_id: string }>(
        "select callback_consumer_id from public.org_esign_integrations where org_id=$1",
        [orgId],
      )
    ).rows[0].callback_consumer_id;

    await setup.query(
      `insert into public.esign_template_staging_sources (
         id,org_id,storage_path,source_filename,source_size_bytes,
         content_type,source_sha256,cleanup_outcome,cleanup_attempted_at,created_by
       ) values (
         $1,$2,($2::uuid)::text || '/' || ($1::uuid)::text || '.pdf',
         'source.pdf',1024,'application/pdf',repeat('a',64),'deleted',now(),$3
       )`,
      [sourceId, orgId, userId],
    );
    await setup.query(
      `insert into public.esign_templates (
         id,org_id,name,document_type,seller_role,signer_roles,
         merge_field_names,sign_template_id,provider_account_id,
         staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,
         lifecycle_state,staging_deleted_at,created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         'provider-template-' || ($1::uuid)::text,'account-a',$3,'source.pdf',1024,
         'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',
         now(),'finalized',now(),$4,$4
       )`,
      [templateId, orgId, sourceId, userId],
    );
    await setup.query(
      `insert into public.esign_requests (
         id,org_id,property_id,template_id,signer_snapshot,merge_value_snapshot,
         status,delivery_state,test_mode,sign_request_id,sent_at,send_intent_id,
         payload_hash,claimed_homeowner_contact_id,created_by
       ) values
         ($1,$3,$4,$5,$6::jsonb,$7::jsonb,'awaiting','sending',true,null,null,gen_random_uuid(),repeat('b',64),$8,$9),
         ($2,$3,$4,$5,$6::jsonb,$7::jsonb,'awaiting','sent',true,'provider-in-flight',now(),gen_random_uuid(),repeat('c',64),$8,$9)`,
      [
        sendingRequestId,
        inFlightRequestId,
        orgId,
        propertyId,
        templateId,
        signerSnapshot,
        mergeSnapshot,
        contactId,
        userId,
      ],
    );
    await setup.query(
      `insert into public.esign_request_signers (
         org_id,request_id,role_name,signer_order,signer_name,signer_email,
         provider_signature_id
       ) values (
         $1,$2,'Seller',0,'Seller Owner','pending-disconnect@example.com',
         'signature-in-flight'
       )`,
      [orgId, inFlightRequestId],
    );

    const disconnect = (
      await setup.query<{
        disconnected: boolean;
        sending_enabled: boolean;
        credentials_present: boolean;
        disconnect_pending: boolean;
        message: string;
      }>(
        "select * from public.disconnect_org_esign_integration($1,$2)",
        [orgId, userId],
      )
    ).rows[0];
    expect(disconnect).toMatchObject({
      disconnected: false,
      sending_enabled: false,
      credentials_present: true,
      disconnect_pending: true,
    });
    expect(disconnect.message).toMatch(/2 signature requests/i);
    expect(disconnect.message).toMatch(/callback ingestion and read credentials are preserved/i);

    expect(
      (
        await setup.query<{
          sending_enabled: boolean;
          has_pending_disconnect: boolean;
          has_credentials: boolean;
          consumer_enabled: boolean;
          consumer_revoked: boolean;
        }>(
          `select
             integration.sending_enabled,
             integration.disconnect_pending_at is not null as has_pending_disconnect,
             integration.api_key_encrypted is not null as has_credentials,
             consumer.enabled as consumer_enabled,
             consumer.revoked_at is not null as consumer_revoked
           from public.org_esign_integrations integration
           join public.webhook_consumers consumer
             on consumer.id = integration.callback_consumer_id
           where integration.org_id=$1`,
          [orgId],
        )
      ).rows[0],
    ).toEqual({
      sending_enabled: false,
      has_pending_disconnect: true,
      has_credentials: true,
      consumer_enabled: true,
      consumer_revoked: false,
    });
    expect(
      (
        await setup.query<{ sending_enabled: boolean; api_key: string }>(
          "select sending_enabled, api_key from public.get_org_esign_credentials($1,$2)",
          [orgId, "synthetic-encryption-key"],
        )
      ).rows[0],
    ).toEqual({ sending_enabled: false, api_key: "synthetic-api-key" });
    expect(
      (
        await setup.query<{ allowed: boolean }>(
          "select has_column_privilege('authenticated','public.org_esign_integrations','disconnect_pending_at','select') as allowed",
        )
      ).rows[0],
    ).toEqual({ allowed: true });

    expect(
      (
        await setup.query<{ outcome: string; blocker_code: string | null }>(
          `select outcome, blocker_code
           from public.create_esign_request(
             $1,$2,$3,$4::jsonb,$5::jsonb,gen_random_uuid(),repeat('d',64),null,$6
           )`,
          [orgId, propertyId, templateId, signerSnapshot, mergeSnapshot, userId],
        )
      ).rows[0],
    ).toEqual({ outcome: "blocked", blocker_code: "ESIGN_SENDING_UNAVAILABLE" });
    await expect(
      setup.query(
        `select public.prepare_esign_template_source_upload(
          $1,$2,'new-source.pdf',1024,'application/pdf',repeat('e',64),$3
        )`,
        [orgId, crypto.randomUUID(), userId],
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/template management capability/i),
    });

    const claim = (
      await setup.query<{
        outcome: string;
        receipt_id: string;
        lease_id: string | null;
      }>(
        `select * from public.claim_esign_webhook_receipt(
          $1,$2,repeat('1',64),repeat('2',64),repeat('3',64),
          'signature_request_signed','provider-in-flight','signature-in-flight',
          $3::timestamptz,
          jsonb_build_object(
            'event_time',floor(extract(epoch from $3::timestamptz))::bigint::text,
            'event_type','signature_request_signed',
            'sign_request_id','provider-in-flight',
            'related_signature_id','signature-in-flight',
            'reported_for_app_id','synthetic-client'
          ),
          now(),$4,300
        )`,
        [orgId, consumerId, eventAt, leaseId],
      )
    ).rows[0];
    expect(claim).toEqual({
      outcome: "claimed",
      receipt_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      lease_id: leaseId,
    });
    await setup.query(
      "select public.complete_esign_webhook_receipt($1,$2,'ignored','AUDIT_ONLY_EVENT')",
      [claim.receipt_id, leaseId],
    );
    expect(
      (
        await setup.query<{
          signer_status: string;
          processing_status: string;
          processing_error: string | null;
          esign_request_id: string;
        }>(
          `select
             signer.status as signer_status,
             receipt.processing_status,
             receipt.processing_error,
             receipt.esign_request_id
           from public.esign_request_signers signer
           join public.esign_webhook_receipts receipt
             on receipt.esign_request_id = signer.request_id
           where signer.org_id=$1
             and signer.request_id=$2
             and receipt.id=$3`,
          [orgId, inFlightRequestId, claim.receipt_id],
        )
      ).rows[0],
    ).toEqual({
      signer_status: "signed",
      processing_status: "ignored",
      processing_error: "AUDIT_ONLY_EVENT",
      esign_request_id: inFlightRequestId,
    });
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
         sign_template_id,provider_account_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         ($1::uuid)::text,'account-a',$3::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',now(),'finalized',$4::uuid,$4::uuid
       )`,
      [templateId, orgId, sourceId, userId],
    );
    await setup.query(
      `select public.upsert_org_esign_integration(
         $1,'synthetic-api-key','-key','synthetic-client','account-a',
         repeat('f',64),$2,'synthetic-encryption-key'
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
    await setup.query(
      `select public.upsert_org_esign_integration(
         $1,'synthetic-api-key','-key','synthetic-client','account-a',
         repeat('a',64),$2,'synthetic-encryption-key'
       )`,
      [orgId, userId],
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
         merge_field_names,sign_template_id,provider_account_id,staging_source_id,
         source_filename,source_size_bytes,source_content_type,source_sha256,
         staging_path,finalized_at,lifecycle_state,created_by,updated_by
       ) values (
         $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         $3,'account-a',$4::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
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
           merge_field_names,sign_template_id,provider_account_id,staging_source_id,
           source_filename,source_size_bytes,source_content_type,source_sha256,
           staging_path,lifecycle_state,supersedes_template_id,created_by,updated_by
         ) values (
           $1::uuid,$2::uuid,'Purchase agreement','purchase_agreement','Seller',
           '[{"name":"Seller","order":0}]'::jsonb,
           array['seller_name','property_address','offer_price','closing_date','earnest_money'],
           $3,'account-a',$4::uuid,'source.pdf',1024,'application/pdf',repeat('a',64),
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
        message: expect.stringMatching(/no longer active/i),
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
         sign_template_id,provider_account_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         ($1::uuid)::text,'account-a',$3,'source.pdf',1024,'application/pdf',repeat('a',64),
         ($2::uuid)::text || '/' || ($3::uuid)::text || '.pdf',now(),'finalized',$4,$4
       )`,
      [templateId, orgId, sourceId, userId],
    );
    await setup.query(
      `select public.upsert_org_esign_integration(
         $1,'synthetic-api-key','-key','synthetic-client','account-a',
         repeat('f',64),$2,'synthetic-encryption-key'
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
         sign_template_id,provider_account_id,staging_source_id,source_filename,source_size_bytes,
         source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,
         created_by,updated_by
       ) values (
         $1,$2,'Purchase agreement','purchase_agreement','Seller',
         '[{"name":"Seller","order":0}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         'provider-template','account-a',$3,'source.pdf',1024,'application/pdf',repeat('a',64),
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
    await expect(
      setup.query(
        `select public.attach_esign_request_provider_delivery(
          $1,$2::uuid,'provider-body-only','webhook',
          jsonb_build_object(
            'source','dropbox_metadata_sandra_request_id',
            'localRequestId',$2::text,
            'providerRequestId','provider-body-only'
          )
        )`,
        [orgId, metadataRequestId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await setup.query(
      `select public.attach_esign_request_provider_delivery(
        $1,$2::uuid,'provider-after-timeout','webhook',
        jsonb_build_object(
          'source','dropbox_provider_read_sandra_request_id',
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
          [
            [
              operatorRequestId,
              automaticRequestId,
              metadataRequestId,
              metadataMissingLocalRequestId,
            ],
          ],
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
