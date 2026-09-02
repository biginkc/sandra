import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";

const { Client } = pg;

const adminUrl = process.env.LOCAL_REHEARSAL_DATABASE_URL ?? null;
const parsedAdminUrl = adminUrl ? new URL(adminUrl) : null;
if (parsedAdminUrl) {
  if (
    parsedAdminUrl.hostname !== "localhost" &&
    parsedAdminUrl.hostname !== "127.0.0.1" &&
    parsedAdminUrl.hostname !== ""
  ) {
    throw new Error("Refusing to run eSign rehearsal against a non-local database.");
  }
}
const dbName = `sandra_esign_essentials_${process.pid}_${Date.now()}`;
const migrationSql = readFileSync(
  "supabase/migrations/20260902180000_esign_essentials_production_path.sql",
  "utf8",
);

const q = (value) => `"${value.replaceAll('"', '""')}"`;
const dbUrl = parsedAdminUrl ? new URL(adminUrl) : null;
if (dbUrl) dbUrl.pathname = `/${dbName}`;

function localClient(database = "postgres") {
  if (database === "postgres" && adminUrl) {
    return new Client({ connectionString: adminUrl });
  }
  if (dbUrl) {
    const url = new URL(dbUrl.toString());
    url.pathname = `/${database}`;
    return new Client({ connectionString: url.toString() });
  }
  return new Client({ host: "localhost", port: 5432, database });
}

const ids = {
  org: "10000000-0000-4000-8000-000000000001",
  owner: "10000000-0000-4000-8000-000000000002",
  member: "10000000-0000-4000-8000-000000000003",
  consumer: "10000000-0000-4000-8000-000000000004",
  contact: "10000000-0000-4000-8000-000000000005",
  property: "10000000-0000-4000-8000-000000000006",
  template: "10000000-0000-4000-8000-000000000007",
};

const metadata = {
  providerTemplateId: "provider-template-1",
  title: "Provider title",
  isEmbedded: false,
  canEdit: null,
  isCreator: null,
  isLocked: false,
  accounts: [{ accountId: "provider-account-1", isLocked: null }],
  signerRoles: [
    { name: "Seller", order: 0 },
    { name: "Buyer", order: 1 },
  ],
  mergeFieldNames: [
    "seller_name",
    "property_address",
    "offer_price",
    "closing_date",
    "earnest_money",
  ],
  documents: [
    {
      index: 0,
      name: "purchase-agreement.pdf",
      customFields: [
        {
          documentIndex: 0,
          apiId: "seller-name-api",
          name: "seller_name",
          type: "text",
          required: false,
          signer: null,
          assignedTo: "sender",
          signerRoleName: null,
        },
        {
          documentIndex: 0,
          apiId: "property-address-api",
          name: "property_address",
          type: "text",
          required: false,
          signer: null,
          assignedTo: "sender",
          signerRoleName: null,
        },
        {
          documentIndex: 0,
          apiId: "offer-price-api",
          name: "offer_price",
          type: "text",
          required: false,
          signer: null,
          assignedTo: "sender",
          signerRoleName: null,
        },
        {
          documentIndex: 0,
          apiId: "closing-date-api",
          name: "closing_date",
          type: "text",
          required: false,
          signer: null,
          assignedTo: "sender",
          signerRoleName: null,
        },
        {
          documentIndex: 0,
          apiId: "earnest-money-api",
          name: "earnest_money",
          type: "text",
          required: false,
          signer: null,
          assignedTo: "sender",
          signerRoleName: null,
        },
      ],
      formFields: [
        {
          documentIndex: 0,
          apiId: "seller-signature-api",
          name: "Seller signature",
          type: "signature",
          required: true,
          signer: "1",
          assignedTo: "signer",
          signerRoleName: "Seller",
        },
        {
          documentIndex: 0,
          apiId: "buyer-signature-api",
          name: "Buyer signature",
          type: "signature",
          required: true,
          signer: "2",
          assignedTo: "signer",
          signerRoleName: "Buyer",
        },
      ],
    },
  ],
};
metadata.mergeFields = metadata.documents.flatMap((document) => document.customFields);
metadata.formFields = metadata.documents.flatMap((document) => document.formFields);

const signerSnapshot = [
  { role: "Seller", name: "Seller Owner", emailAddress: "seller@example.com" },
  { role: "Buyer", name: "Buyer One", emailAddress: "buyer@example.com" },
];
const mergeSnapshot = {
  seller_name: "Seller Owner",
  property_address: "123 Main St",
  offer_price: "$125,000",
  closing_date: "2026-09-30",
  earnest_money: "$1,000",
};

const baseSql = `
create extension if not exists pgcrypto;
create schema auth;
create table auth.users(id uuid primary key);
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role; end if;
end
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claim.role', true), '')
$$;
create table public.organizations(id uuid primary key, name text);
create table public.memberships(
  org_id uuid not null,
  user_id uuid not null,
  role text not null,
  access_status text not null default 'active',
  deletion_prepared_at timestamptz,
  access_expires_at timestamptz
);
create function public.hugo_has_active_org_access(p_org_id uuid)
returns boolean language sql stable as $$
  select true
$$;
create function public.esign_require_active_owner(p_org_id uuid, p_actor_id uuid)
returns void language plpgsql as $$
begin
  if not exists (
    select 1 from public.memberships
    where org_id = p_org_id and user_id = p_actor_id and role = 'owner'
      and access_status = 'active' and deletion_prepared_at is null
      and (access_expires_at is null or access_expires_at > now())
  ) then
    raise exception 'owner required' using errcode = '42501';
  end if;
end;
$$;
create type public.esign_request_status as enum (
  'awaiting', 'viewed', 'signed', 'declined', 'voided', 'error'
);
create type public.esign_request_claim_outcome as enum (
  'created', 'existing_same_payload', 'intent_conflict', 'blocked'
);
create type public.esign_delivery_state as enum (
  'sending', 'sent', 'send_unknown', 'email_bounced', 'failed'
);
create table public.webhook_consumers(
  id uuid primary key,
  org_id uuid not null,
  consumer_type text not null,
  enabled boolean not null default true,
  revoked_at timestamptz
);
create table public.org_esign_integrations(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  provider text not null default 'dropbox_sign',
  api_key_encrypted bytea,
  api_key_last_four text,
  client_id text,
  callback_consumer_id uuid,
  callback_verified_at timestamptz,
  sending_enabled boolean not null default false,
  test_mode boolean not null default true,
  connected_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  disconnect_pending_at timestamptz,
  disconnect_requested_by uuid,
  provider_account_id text,
  unique(org_id, provider)
);
alter table public.org_esign_integrations enable row level security;
create policy org_esign_integrations_org_select
  on public.org_esign_integrations for select to authenticated
  using (public.hugo_has_active_org_access(org_id));
revoke all on table public.org_esign_integrations
  from public, anon, authenticated, service_role;
grant select (
  id, org_id, provider, api_key_last_four, client_id, sending_enabled,
  test_mode, callback_verified_at, disconnect_pending_at, connected_by,
  created_at, updated_by, updated_at
) on public.org_esign_integrations to authenticated;
grant all on table public.org_esign_integrations to service_role;
create table public.esign_templates(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  name text not null,
  document_type text not null,
  seller_role text not null,
  signer_roles jsonb not null,
  merge_field_names text[] not null,
  sign_template_id text,
  provider_account_id text,
  staging_source_id uuid,
  source_filename text,
  source_size_bytes bigint,
  source_content_type text,
  source_sha256 text,
  staging_path text,
  staging_deleted_at timestamptz,
  finalized_at timestamptz,
  lifecycle_state text not null default 'finalized',
  duplicate_of_template_id uuid,
  supersedes_template_id uuid,
  preparation_error_code text,
  abandoned_by uuid,
  abandoned_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  deleted_by uuid,
  deleted_at timestamptz
);
create table public.properties(
  id uuid primary key,
  org_id uuid not null,
  homeowner_contact_id uuid
);
create table public.contacts(
  id uuid primary key,
  org_id uuid not null,
  email text,
  phone_1 text
);
create table public.esign_requests(
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  property_id uuid not null,
  template_id uuid not null,
  signer_snapshot jsonb not null,
  merge_value_snapshot jsonb not null,
  status public.esign_request_status not null default 'awaiting',
  delivery_state public.esign_delivery_state not null default 'sending',
  test_mode boolean not null default true,
  send_intent_id uuid not null,
  payload_hash text not null,
  retry_of_request_id uuid,
  claimed_homeowner_contact_id uuid,
  sign_request_id text,
  signed_pdf_path text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(org_id, send_intent_id)
);
create table public.esign_request_signers(
  org_id uuid not null,
  request_id uuid not null,
  role_name text not null,
  signer_order integer not null,
  signer_name text not null,
  signer_email text not null
);
create table public.lead_events(
  org_id uuid not null,
  property_id uuid not null,
  actor_type text,
  actor_id uuid,
  event_type text,
  payload jsonb,
  source_type text,
  source_id uuid
);
create unique index lead_events_source_idx
  on public.lead_events(source_type, source_id)
  where source_id is not null;
create function public.esign_request_payload_is_valid(
  p_signers jsonb,
  p_merge_values jsonb,
  p_template_roles jsonb
)
returns boolean language sql immutable as $$
  select jsonb_typeof(p_signers) = 'array'
    and jsonb_typeof(p_merge_values) = 'object'
    and jsonb_array_length(p_signers) = jsonb_array_length(p_template_roles)
    and (
      select array_agg(key order by key)
      from jsonb_object_keys(p_merge_values) key
    ) = array[
      'closing_date', 'earnest_money', 'offer_price',
      'property_address', 'seller_name'
    ]::text[];
$$;
`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function setServiceRole(client) {
  await client.query("select set_config('request.jwt.claim.role','service_role',false)");
}

async function createRequest(client, sendIntentId = randomUUID()) {
  const result = await client.query(
    `select * from public.create_esign_request(
      $1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9
    )`,
    [
      ids.org,
      ids.property,
      ids.template,
      JSON.stringify(signerSnapshot),
      JSON.stringify(mergeSnapshot),
      sendIntentId,
      "b".repeat(64),
      null,
      ids.owner,
    ],
  );
  assert(result.rows[0].outcome === "created", "live create_esign_request did not create");
  assert(result.rows[0].test_mode === false, "request mode was not snapshotted live");
  return result.rows[0].id;
}

const admin = localClient();
await admin.connect();
try {
  await admin.query(`create database ${q(dbName)}`);
  const client = localClient(dbName);
  await client.connect();
  try {
    await client.query(baseSql);
    await client.query(migrationSql);
    await client.query(migrationSql);
    await setServiceRole(client);

    await client.query(
      `insert into auth.users(id) values ($1),($2),($3)`,
      [ids.owner, ids.member, ids.contact],
    );
    await client.query(`insert into public.organizations(id, name) values ($1, 'BMH')`, [ids.org]);
    await client.query(
      `insert into public.memberships(org_id,user_id,role) values ($1,$2,'owner'),($1,$3,'member')`,
      [ids.org, ids.owner, ids.member],
    );
    await client.query(
      `insert into public.webhook_consumers(id,org_id,consumer_type,enabled)
       values ($1,$2,'esign_provider',true)`,
      [ids.consumer, ids.org],
    );
    await client.query(
      `insert into public.org_esign_integrations(
        org_id, api_key_encrypted, api_key_last_four, client_id,
        callback_consumer_id, callback_verified_at, sending_enabled,
        test_mode, connected_by, updated_by, provider_account_id,
        live_send_monthly_used, live_send_monthly_period_key
      ) values ($1, convert_to('redacted','utf8'), '1234', 'client-1',
        $2, now(), true, false, $3, $3, 'provider-account-1', 40, '2026-08')`,
      [ids.org, ids.consumer, ids.owner],
    );
    await client.query(
      `insert into public.properties(id, org_id, homeowner_contact_id)
       values ($1,$2,$3)`,
      [ids.property, ids.org, ids.contact],
    );
    await client.query(
      `insert into public.contacts(id, org_id, email, phone_1)
       values ($1,$2,'seller@example.com',null)`,
      [ids.contact, ids.org],
    );

    const registered = await client.query(
      `select * from public.register_dropbox_website_esign_template(
        $1,$2,$3,$4,$5,$6,$7::jsonb
      )`,
      [
        ids.org,
        ids.owner,
        metadata.providerTemplateId,
        "Local label",
        "Purchase agreement",
        "provider-account-1",
        JSON.stringify(metadata),
      ],
    );
    assert(registered.rows[0].outcome === "registered", "initial website registration failed");
    assert(registered.rows[0].template_id === ids.template || registered.rows[0].template_id, "missing registered template id");
    ids.template = registered.rows[0].template_id;

    await client.query(
      `update public.esign_templates set deleted_at = now(), deleted_by = $2 where id = $1`,
      [ids.template, ids.owner],
    );
    const restored = await client.query(
      `select * from public.register_dropbox_website_esign_template(
        $1,$2,$3,$4,$5,$6,$7::jsonb
      )`,
      [
        ids.org,
        ids.owner,
        metadata.providerTemplateId,
        "Restored label",
        "Purchase agreement",
        "provider-account-1",
        JSON.stringify(metadata),
      ],
    );
    assert(restored.rows[0].outcome === "restored", "soft-deleted provider pair was not restored");
    const duplicateCount = await client.query(
      `select count(*)::int as count from public.esign_templates
       where provider_account_id = 'provider-account-1' and sign_template_id = 'provider-template-1'`,
    );
    assert(duplicateCount.rows[0].count === 1, "provider pair duplicated across soft deletion");
    const deprecatedOnlyMetadata = {
      ...metadata,
      documents: [],
      mergeFields: [],
      formFields: [],
      namedFormFields: metadata.mergeFieldNames.map((name) => ({ name })),
    };
    const deprecatedOnlyValid = await client.query(
      `select public.esign_website_template_metadata_is_valid($1,$2,$3::jsonb) as valid`,
      [
        metadata.providerTemplateId,
        "provider-account-1",
        JSON.stringify(deprecatedOnlyMetadata),
      ],
    );
    assert(
      deprecatedOnlyValid.rows[0].valid === false,
      "SQL accepted deprecated-only template metadata",
    );

    const requestId = await createRequest(client);
    const reserved = await client.query(
      `select public.reserve_esign_live_send($1,$2,11) as outcome`,
      [ids.org, requestId],
    );
    assert(reserved.rows[0].outcome === "reserved", "provider remaining 11 should reserve");
    const quota = await client.query(
      `select live_send_monthly_used, live_send_monthly_period_key
       from public.org_esign_integrations where org_id = $1`,
      [ids.org],
    );
    assert(quota.rows[0].live_send_monthly_used === 1, "monthly period did not reset atomically");
    assert(quota.rows[0].live_send_monthly_period_key !== "2026-08", "period key did not roll over");

    const lowQuotaRequestId = await createRequest(client);
    const blocked = await client.query(
      `select public.reserve_esign_live_send($1,$2,10) as outcome`,
      [ids.org, lowQuotaRequestId],
    );
    assert(blocked.rows[0].outcome === "blocked", "provider remaining 10 must fail closed");

    await client.query(
      `insert into public.esign_templates(
        org_id,name,document_type,seller_role,signer_roles,merge_field_names,
        sign_template_id,provider_account_id,template_origin,finalized_at,lifecycle_state,
        staging_source_id,source_filename,source_size_bytes,source_content_type,
        source_sha256,staging_path,created_by,updated_by
      ) values (
        $1::uuid,'Embedded','purchase_agreement','Seller',
        '[{"name":"Seller","order":0},{"name":"Buyer","order":1}]'::jsonb,
        array['seller_name','property_address','offer_price','closing_date','earnest_money'],
        'embedded-provider-1','provider-account-1','sandra_embedded',now(),'finalized',
        $2::uuid,'embedded.pdf',1024,'application/pdf',$3,$1::uuid::text || '/' || $2::uuid::text || '.pdf',$4::uuid,$4::uuid
      )`,
      [ids.org, randomUUID(), "c".repeat(64), ids.owner],
    );
    const embeddedBlocked = await client.query(
      `select blocker_code from public.create_esign_request(
        $1,$2,(select id from public.esign_templates where sign_template_id='embedded-provider-1'),
        $3::jsonb,$4::jsonb,$5,$6,null,$7
      )`,
      [
        ids.org,
        ids.property,
        JSON.stringify(signerSnapshot),
        JSON.stringify(mergeSnapshot),
        randomUUID(),
        "b".repeat(64),
        ids.owner,
      ],
    );
    assert(
      embeddedBlocked.rows[0].blocker_code === "FINALIZED_TEMPLATE_NOT_FOUND",
      "live request accepted an embedded-origin template",
    );

    await client.query(
      `update public.org_esign_integrations
       set live_send_monthly_used = 39,
           live_send_monthly_period_key = to_char(now() at time zone 'America/Chicago', 'YYYY-MM')
       where org_id = $1`,
      [ids.org],
    );
    const requestA = await createRequest(client);
    const requestB = await createRequest(client);
    const c1 = localClient(dbName);
    const c2 = localClient(dbName);
    await Promise.all([c1.connect(), c2.connect()]);
    try {
      await Promise.all([setServiceRole(c1), setServiceRole(c2)]);
      const outcomes = await Promise.all([
        c1.query(`select public.reserve_esign_live_send($1,$2,11) as outcome`, [ids.org, requestA]),
        c2.query(`select public.reserve_esign_live_send($1,$2,11) as outcome`, [ids.org, requestB]),
      ]);
      assert(
        outcomes.map((result) => result.rows[0].outcome).sort().join(",") === "blocked,reserved",
        "concurrent live reservations did not enforce the monthly cap exactly",
      );
    } finally {
      await Promise.all([c1.end(), c2.end()]);
    }

    const grants = await client.query(
      `select column_name
       from information_schema.column_privileges
       where table_schema = 'public'
         and table_name = 'org_esign_integrations'
         and grantee = 'authenticated'
         and privilege_type = 'SELECT'
       order by column_name`,
    );
    const granted = new Set(grants.rows.map((row) => row.column_name));
    assert(granted.has("live_send_monthly_period_key"), "authenticated lacks safe period-key read grant");
    assert(!granted.has("api_key_encrypted"), "authenticated can read encrypted Dropbox credentials");
    await client.query("set role authenticated");
    try {
      await client.query(
        `select live_send_monthly_used, live_send_monthly_period_key
         from public.org_esign_integrations where org_id = $1`,
        [ids.org],
      );
      let encryptedReadBlocked = false;
      try {
        await client.query(
          `select api_key_encrypted from public.org_esign_integrations where org_id = $1`,
          [ids.org],
        );
      } catch {
        encryptedReadBlocked = true;
      }
      assert(encryptedReadBlocked, "authenticated selected encrypted Dropbox credentials");
    } finally {
      await client.query("reset role");
      await setServiceRole(client);
    }

    console.log("eSign Essentials local rehearsal passed");
  } finally {
    await client.end().catch(() => {});
  }
} finally {
  await admin.query(`drop database if exists ${q(dbName)} with (force)`).catch(() => {});
  await admin.end();
}
