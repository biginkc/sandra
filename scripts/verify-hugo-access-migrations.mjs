#!/usr/bin/env node

/**
 * Replay Sandra's Hugo migrations against a disposable PostgreSQL 17 cluster.
 * The fixture models only the pre-Hugo Supabase objects these migrations touch;
 * it never connects to a hosted project.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const freshMigrationNames = [
  "20260727150000_hugo_access_provisioner.sql",
  "20260728090000_hugo_access_inventory.sql",
  "20260728110000_hugo_auth_hard_delete.sql",
  "20260728130000_hugo_access_operation_request_hash.sql",
  "20260728150000_hugo_access_authorization_hardening.sql",
];
const hostedSnapshotNames = freshMigrationNames.slice(0, 4);
const hostedSnapshotSourceCommit =
  "415c283cec47b71ac03cd1cdbb3aa1149a4ef4c5";
const hostedSnapshotHashes = {
  "20260727150000_hugo_access_provisioner.sql":
    "4b2ff1db73dc4e1c45c0073c48f4c9efc8f28a7137e7f8f1f456699adcfc6fe6",
  "20260728090000_hugo_access_inventory.sql":
    "a24caade50a7e6a40493de99df910f2c5edb133a648f89439079bc67ecebb93e",
  "20260728110000_hugo_auth_hard_delete.sql":
    "10aca97615d337bc2aa68963f4e40a2ff09a5787018f826801677f6a4dc89e7b",
  "20260728130000_hugo_access_operation_request_hash.sql":
    "1c2bb328614e17b2fa221fe7685da11dfe8a3fc09110e0fecac8ceeb37abc67c",
};
const lane = process.env.SANDRA_HUGO_VERIFY_LANE ?? "all";
const scriptPath = fileURLToPath(import.meta.url);

if (lane === "all") {
  for (const childLane of ["hosted-snapshot-forward", "fresh-full-chain"]) {
    execFileSync(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, SANDRA_HUGO_VERIFY_LANE: childLane },
      stdio: "inherit",
    });
  }
  console.log(JSON.stringify({
    ok: true,
    lanes: ["hosted-snapshot-forward", "fresh-full-chain"],
  }));
  process.exit(0);
}

if (!["hosted-snapshot-forward", "fresh-full-chain"].includes(lane)) {
  throw new Error(`Unknown Sandra Hugo verification lane: ${lane}`);
}

const migrationNames =
  lane === "fresh-full-chain"
    ? freshMigrationNames
    : [...hostedSnapshotNames, freshMigrationNames.at(-1)];
const migrations =
  lane === "fresh-full-chain"
    ? freshMigrationNames.map((name) =>
        join(root, "supabase", "migrations", name),
      )
    : [
        ...hostedSnapshotNames.map((name) =>
          join(root, "scripts", "fixtures", "hugo-hosted-snapshot", name),
        ),
        join(
          root,
          "supabase",
          "migrations",
          freshMigrationNames.at(-1),
        ),
      ];

if (lane === "hosted-snapshot-forward") {
  for (const [name, expectedHash] of Object.entries(hostedSnapshotHashes)) {
    const path = join(
      root,
      "scripts",
      "fixtures",
      "hugo-hosted-snapshot",
      name,
    );
    const fixture = readFileSync(path);
    const actualHash = createHash("sha256")
      .update(fixture)
      .digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(
        `Hosted migration snapshot changed: ${name} ${actualHash}`,
      );
    }
    let immutableSource;
    try {
      immutableSource = execFileSync(
        "git",
        [
          "show",
          `${hostedSnapshotSourceCommit}:supabase/migrations/${name}`,
        ],
        { cwd: root },
      );
    } catch {
      throw new Error(
        `Immutable hosted snapshot source is unavailable: ${hostedSnapshotSourceCommit}:${name}`,
      );
    }
    if (!fixture.equals(immutableSource)) {
      throw new Error(
        `Hosted migration snapshot does not match immutable source: ${name}`,
      );
    }
  }
}
const pgBin =
  process.env.SANDRA_POSTGRES_BIN ?? "/opt/homebrew/opt/postgresql@17/bin";
const binary = (name) => join(pgBin, name);

function run(name, args, options = {}) {
  return execFileSync(binary(name), args, {
    stdio: "inherit",
    ...options,
  });
}

function sql(port, socket, statement, options = {}) {
  return execFileSync(
    binary("psql"),
    [
      "-h",
      socket,
      "-p",
      String(port),
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      ...options.extraArgs ?? [],
    ],
    {
      input: statement,
      stdio: options.capture
        ? ["pipe", "pipe", "inherit"]
        : ["pipe", "inherit", "inherit"],
      encoding: options.capture ? "utf8" : undefined,
    },
  );
}

function sqlAsync(port, socket, statement) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      binary("psql"),
      [
        "-h",
        socket,
        "-p",
        String(port),
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `psql exited ${code}`));
    });
    child.stdin.end(statement);
  });
}

async function waitForActiveQuery(port, socket, applicationName) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const active = sql(
      port,
      socket,
      `
        select count(*)
        from pg_stat_activity
        where application_name = '${applicationName}'
          and state = 'active'
          and query like 'select pg_sleep%';
      `,
      { capture: true, extraArgs: ["-Atq"] },
    ).trim();
    if (active === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for SQL fixture: ${applicationName}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a local PostgreSQL port");
  return port;
}

const cluster = await mkdtemp(join(tmpdir(), "sandra-hugo-migrations-"));
const port = await freePort();
let started = false;

try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres"], {
    stdio: "ignore",
  });
  run(
    "pg_ctl",
    [
      "-D",
      cluster,
      "-o",
      `-p ${port} -k ${cluster}`,
      "-l",
      join(cluster, "server.log"),
      "start",
    ],
    { stdio: "ignore" },
  );
  started = true;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      run("pg_isready", [
        "-h",
        cluster,
        "-p",
        String(port),
        "-U",
        "postgres",
      ], { stdio: "ignore" });
      break;
    } catch (error) {
      if (attempt === 49) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  sql(port, cluster, `
    create schema extensions;
    create extension if not exists pgcrypto with schema extensions;
    -- The committed hosted snapshots straddle both resolution surfaces:
    -- 271500 calls public.digest while 281300 calls extensions.digest.
    create function public.digest(bytea, text)
    returns bytea language sql immutable
    as $$ select extensions.digest($1, $2) $$;
    create schema auth;
    create schema storage;
    create role anon;
    create role authenticated;
    create role service_role;

    create function auth.role()
    returns text language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
    create function auth.uid()
    returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    create table auth.users (
      id uuid primary key default gen_random_uuid(),
      email text,
      last_sign_in_at timestamptz
    );
    create table auth.identities (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      last_sign_in_at timestamptz
    );
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      owner_id text,
      owner uuid
    );

    create table public.organizations (
      id uuid primary key,
      name text not null
    );
    insert into public.organizations(id, name)
    values ('00000000-0000-0000-0000-000000000bbb', 'BMH Group');

    create table public.memberships (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references auth.users(id) on delete cascade,
      org_id uuid not null references public.organizations(id),
      role text not null default 'member'
        check (role in ('owner', 'member')),
      created_at timestamptz not null default now(),
      unique(user_id, org_id)
    );
    alter table public.memberships enable row level security;
    create policy memberships_self_select on public.memberships
      for select to authenticated using (user_id = auth.uid());
    grant select, update on public.memberships to authenticated;

    create table public.contacts (
      id uuid primary key,
      org_id uuid not null references public.organizations(id)
    );
    create table public.properties (
      id uuid primary key,
      org_id uuid not null references public.organizations(id)
    );
    create table public.campaigns (
      id uuid primary key,
      org_id uuid not null references public.organizations(id)
    );
    create table public.user_activity (
      id uuid primary key default gen_random_uuid(),
      actor_user_id uuid references auth.users(id) on delete set null
    );
    create table public.csv_imports (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references auth.users(id)
    );
    create table public.jobs (
      id uuid primary key default gen_random_uuid(),
      created_by uuid references auth.users(id)
    );
    create table public.property_merges (
      id uuid primary key default gen_random_uuid(),
      merged_by uuid references auth.users(id)
    );
    create table public.notifications (
      id uuid primary key default gen_random_uuid(),
      user_id uuid references auth.users(id)
    );
    create table public.lead_notes (
      id uuid primary key default gen_random_uuid(),
      author_user_id uuid references auth.users(id)
    );
    create table public.lists (
      id uuid primary key default gen_random_uuid(),
      created_by uuid references auth.users(id)
    );
    create table public.sms_templates (
      id uuid primary key default gen_random_uuid(),
      created_by uuid references auth.users(id)
    );
    create table public.sequences (
      id uuid primary key default gen_random_uuid(),
      created_by uuid references auth.users(id)
    );
    create table public.sequence_enrollments (
      id uuid primary key default gen_random_uuid(),
      enrolled_by_user_id uuid references auth.users(id)
    );
    create table public.tasks (
      id uuid primary key default gen_random_uuid(),
      assignee_id uuid references auth.users(id),
      created_by uuid references auth.users(id)
    );

    create table public.skip_trace_cache (
      id uuid primary key default gen_random_uuid(),
      value text
    );
    alter table public.skip_trace_cache enable row level security;
    create policy skip_trace_cache_authenticated_select
      on public.skip_trace_cache for select to authenticated using (true);
    grant select on public.skip_trace_cache to authenticated;

    create table public.saved_filters (
      id uuid primary key default gen_random_uuid(),
      org_id uuid not null references public.organizations(id),
      user_id uuid references auth.users(id),
      name text not null,
      filters_json jsonb not null default '{}'::jsonb,
      is_base boolean not null default false
    );
    alter table public.saved_filters enable row level security;
    create policy saved_filters_read_own_plus_base
      on public.saved_filters for select to authenticated
      using (
        user_id = auth.uid()
        or (
          is_base
          and org_id in (
            select org_id from public.memberships
            where user_id = auth.uid()
          )
        )
      );
    create policy saved_filters_insert_own
      on public.saved_filters for insert to authenticated
      with check (user_id = auth.uid());
    create policy saved_filters_update_own
      on public.saved_filters for update to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
    create policy saved_filters_delete_own
      on public.saved_filters for delete to authenticated
      using (user_id = auth.uid());
    grant select, insert, update, delete on public.saved_filters
      to authenticated;

    create table public.user_oauth_tokens (
      user_id uuid not null references auth.users(id),
      provider text not null,
      token_type text not null,
      access_token_encrypted bytea,
      primary key(user_id, provider, token_type)
    );
    alter table public.user_oauth_tokens enable row level security;
    create policy user_oauth_tokens_self_read
      on public.user_oauth_tokens for select to authenticated
      using (user_id = auth.uid());
    grant select on public.user_oauth_tokens to authenticated;

    create table public.user_integration_prefs (
      user_id uuid not null references auth.users(id),
      channel text not null,
      enabled boolean not null default true,
      primary key(user_id, channel)
    );
    alter table public.user_integration_prefs enable row level security;
    create policy user_integration_prefs_self_all
      on public.user_integration_prefs for all to authenticated
      using (user_id = auth.uid()) with check (user_id = auth.uid());
    grant select, insert, update, delete on public.user_integration_prefs
      to authenticated;

    create table public.metric_snapshots (
      id uuid primary key default gen_random_uuid(),
      metric_key text not null
    );
    alter table public.metric_snapshots enable row level security;
    create policy "authenticated users can read metric snapshots"
      on public.metric_snapshots for select to authenticated using (true);
    grant select on public.metric_snapshots to authenticated;

    create table public.counties (
      id uuid primary key default gen_random_uuid(),
      name text not null
    );
    alter table public.counties enable row level security;
    create policy counties_authenticated_select
      on public.counties for select to authenticated using (true);
    grant select on public.counties to authenticated;

    create table public.fips_codes (
      id uuid primary key default gen_random_uuid(),
      code text not null
    );
    alter table public.fips_codes enable row level security;
    create policy fips_codes_authenticated_select
      on public.fips_codes for select to authenticated using (true);
    grant select on public.fips_codes to authenticated;

    create table public.zip_county_xref (
      id uuid primary key default gen_random_uuid(),
      zip text not null
    );
    alter table public.zip_county_xref enable row level security;
    create policy zip_county_xref_authenticated_select
      on public.zip_county_xref for select to authenticated using (true);
    grant select on public.zip_county_xref to authenticated;

    create function public.sms_thread_org_id(uuid, uuid)
    returns uuid language sql stable
    as $$ select '00000000-0000-0000-0000-000000000bbb'::uuid $$;
    create function public.delete_contact(uuid, text)
    returns void language sql as $$ select $$;
    create function public.merge_duplicate_properties(uuid, uuid)
    returns void language sql as $$ select $$;
    create function public.ensure_sms_conversation_id(uuid, uuid)
    returns uuid language sql as $$ select gen_random_uuid() $$;
    create function public.campaign_kpis(uuid)
    returns table (
      audience bigint,
      attempted bigint,
      delivered bigint,
      delivered_rate double precision,
      failed bigint,
      failed_rate double precision,
      replied bigint,
      reply_rate double precision,
      opted_out bigint,
      opt_out_rate double precision
    )
    language sql
    as $$ select 0::bigint, 0::bigint, 0::bigint, 0::double precision,
                 0::bigint, 0::double precision, 0::bigint,
                 0::double precision, 0::bigint, 0::double precision $$;
    create function public.preview_campaign_cadence_reschedule(uuid, integer, integer)
    returns table (
      affected_count bigint,
      first_scheduled_for timestamptz,
      last_scheduled_for timestamptz
    )
    language sql
    as $$ select 0::bigint, null::timestamptz, null::timestamptz $$;

    insert into public.contacts(id, org_id)
    values (
      '10000000-0000-4000-8000-000000000001',
      '00000000-0000-0000-0000-000000000bbb'
    );
    insert into public.properties(id, org_id) values
      ('10000000-0000-4000-8000-000000000002',
       '00000000-0000-0000-0000-000000000bbb'),
      ('10000000-0000-4000-8000-000000000003',
       '00000000-0000-0000-0000-000000000bbb');
    insert into public.campaigns(id, org_id)
    values (
      '10000000-0000-4000-8000-000000000004',
      '00000000-0000-0000-0000-000000000bbb'
    );
  `);

  for (const migration of migrations) {
    run(
      "psql",
      [
        "-h",
        cluster,
        "-p",
        String(port),
        "-U",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        migration,
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }

  // Replaying the forward repair proves a deployment retry does not create a
  // second private-function chain or lose public grants.
  run(
    "psql",
    [
      "-h",
      cluster,
      "-p",
      String(port),
      "-U",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      migrations.at(-1),
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  sql(port, cluster, `
    select set_config('request.jwt.claim.role', 'service_role', false);

    do $$
    declare
      v jsonb;
      v_invalid jsonb;
    begin
      v_invalid := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000001',
        'outsider@example.com',
        'member',
        '{"api_token":"must-never-persist"}'::jsonb,
        'active',
        null
      );
      assert v_invalid->>'proceed' = 'false';
      assert v_invalid->'receipt'->>'error_code' = 'INVALID_DOMAIN';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000001',
        'outsider@example.com',
        'member',
        '{"api_token":"must-never-persist"}'::jsonb,
        'active',
        null
      );
      assert v = v_invalid,
        'exact invalid-domain retry did not replay its receipt';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000001',
        'member@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->'receipt'->>'error_code' = 'OPERATION_CONFLICT',
        'changed valid request reused an invalid-domain operation id';

      v_invalid := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000002',
        'member@bmhgroupkc.com',
        'member',
        '{"api_token":"first-secret"}'::jsonb,
        'active',
        null
      );
      assert v_invalid->'receipt'->>'error_code' = 'INVALID_CONFIG';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000002',
        'member@bmhgroupkc.com',
        'member',
        '{"api_token":"first-secret"}'::jsonb,
        'active',
        null
      );
      assert v = v_invalid,
        'exact invalid-config retry did not replay its receipt';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000002',
        'member@bmhgroupkc.com',
        'member',
        '{"api_token":"second-secret"}'::jsonb,
        'active',
        null
      );
      assert v->'receipt'->>'error_code' = 'OPERATION_CONFLICT',
        'distinct invalid configs collapsed to one request hash';

      v_invalid := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000003',
        'not-an-email',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v_invalid->'receipt'->>'error_code' = 'INVALID_EMAIL';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000003',
        'not-an-email',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v = v_invalid,
        'exact invalid-email retry did not replay its receipt';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000003',
        'member@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->'receipt'->>'error_code' = 'OPERATION_CONFLICT',
        'changed valid request reused an invalid-email operation id';

      v_invalid := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000004',
        'member@bmhgroupkc.com',
        'superadmin',
        '{}'::jsonb,
        'active',
        null
      );
      assert v_invalid->'receipt'->>'error_code' = 'INVALID_ROLE';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000004',
        'member@bmhgroupkc.com',
        'superadmin',
        '{}'::jsonb,
        'active',
        null
      );
      assert v = v_invalid,
        'exact invalid-role retry did not replay its receipt';
      v := public.hugo_preflight_access_operation(
        '10000000-0000-4000-8000-000000000004',
        'member@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->'receipt'->>'error_code' = 'OPERATION_CONFLICT',
        'changed valid request reused an invalid-role operation id';

      assert not exists (
        select 1
        from public.hugo_access_operations op
        where op.operation_id in (
          '10000000-0000-4000-8000-000000000001'::uuid,
          '10000000-0000-4000-8000-000000000002'::uuid,
          '10000000-0000-4000-8000-000000000003'::uuid,
          '10000000-0000-4000-8000-000000000004'::uuid
        )
          and (
            lower(op.email) = 'outsider@example.com'
            or position('outsider@example.com' in op.requested::text) > 0
            or position('outsider@example.com' in op.receipt::text) > 0
            or position('not-an-email' in op.requested::text) > 0
            or position('not-an-email' in op.receipt::text) > 0
            or position('superadmin' in op.requested::text) > 0
            or position('superadmin' in op.receipt::text) > 0
            or position('first-secret' in op.requested::text) > 0
            or position('first-secret' in op.receipt::text) > 0
            or position('must-never-persist' in op.requested::text) > 0
            or position('must-never-persist' in op.receipt::text) > 0
          )
      ), 'invalid request journal retained raw email or secret';
      assert (
        select count(*)
        from public.hugo_access_operations op
        where op.operation_id in (
          '10000000-0000-4000-8000-000000000001'::uuid,
          '10000000-0000-4000-8000-000000000002'::uuid,
          '10000000-0000-4000-8000-000000000003'::uuid,
          '10000000-0000-4000-8000-000000000004'::uuid
        )
          and op.request_hash ~ '^[0-9a-f]{64}$'
          and op.receipt->>'request_hash' = op.request_hash
      ) = 4, 'invalid request receipts were not hash-bound';
      assert not exists (
        select 1
        from public.hugo_access_operation_claims claim
        where claim.operation_id in (
          '10000000-0000-4000-8000-000000000001'::uuid,
          '10000000-0000-4000-8000-000000000002'::uuid,
          '10000000-0000-4000-8000-000000000003'::uuid,
          '10000000-0000-4000-8000-000000000004'::uuid
        )
      ), 'invalid request created a raw preflight claim';

      v := public.hugo_preflight_access_operation(
        '20000000-0000-4000-8000-000000000001',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'true', 'first preflight did not reserve';

      v := public.hugo_preflight_access_operation(
        '20000000-0000-4000-8000-000000000001',
        'owner.one@bmhgroupkc.com',
        'member',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'false', 'changed preflight was not rejected';
      assert v->'receipt'->>'error_code' = 'OPERATION_CONFLICT',
        'changed preflight returned the wrong error';
    end $$;

    insert into auth.users(id, email) values
      ('30000000-0000-4000-8000-000000000001',
       'owner.one@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000002',
       'owner.two@bmhgroupkc.com');

    do $$
    declare
      v jsonb;
    begin
      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000009',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        null
      );
      assert not (v->>'ok')::boolean,
        'access applied without an operation preflight';
      assert v->>'error_code' = 'OPERATION_PREFLIGHT_REQUIRED',
        'missing preflight returned the wrong error';
      assert not exists (
        select 1 from public.memberships
        where user_id = '30000000-0000-4000-8000-000000000001'
      ), 'missing preflight mutated membership state';

      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000001',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        null
      );
      assert (v->>'ok')::boolean, 'first owner grant failed';

      v := public.hugo_preflight_access_operation(
        '20000000-0000-4000-8000-000000000002',
        'owner.two@bmhgroupkc.com',
        'owner',
        '{}'::jsonb,
        'active',
        now() + interval '1 day'
      );
      assert v->>'proceed' = 'true', 'second owner preflight failed';
      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000002',
        'owner.two@bmhgroupkc.com',
        'owner',
        '{}'::jsonb,
        'active',
        now() + interval '1 day'
      );
      assert (v->>'ok')::boolean, 'second owner grant failed';

      v := public.hugo_preflight_access_operation(
        '20000000-0000-4000-8000-000000000003',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        now() + interval '2 days'
      );
      assert v->>'proceed' = 'true', 'owner expiry preflight failed';
      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000003',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        now() + interval '2 days'
      );
      assert not (v->>'ok')::boolean, 'unsafe final-owner expiry succeeded';
      assert v->>'error_code' = 'FINAL_OWNER_GUARD',
        'unsafe owner expiry returned the wrong error';

      v := public.hugo_preflight_access_operation(
        '20000000-0000-4000-8000-000000000004',
        'owner.two@bmhgroupkc.com',
        'owner',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'true', 'permanent owner preflight failed';
      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000004',
        'owner.two@bmhgroupkc.com',
        'owner',
        '{}'::jsonb,
        'active',
        null
      );
      assert (v->>'ok')::boolean, 'finite owner could not become permanent';

      v := public.hugo_preflight_access_operation(
        '20000000-0000-4000-8000-000000000005',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'suspended',
        null
      );
      assert v->>'proceed' = 'true', 'owner suspension preflight failed';
      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000005',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'suspended',
        null
      );
      assert (v->>'ok')::boolean, 'safe owner suspension failed';
    end $$;

    insert into auth.users(id, email) values
      ('30000000-0000-4000-8000-000000000024',
       'expired.member@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000025',
       'deleting.member@bmhgroupkc.com');
    insert into public.memberships(
      user_id, org_id, role, access_status, access_expires_at
    ) values (
      '30000000-0000-4000-8000-000000000024',
      '00000000-0000-0000-0000-000000000bbb',
      'member',
      'active',
      now() - interval '1 second'
    ), (
      '30000000-0000-4000-8000-000000000025',
      '00000000-0000-0000-0000-000000000bbb',
      'member',
      'active',
      null
    );
    update public.memberships
    set deletion_prepared_at = now()
    where user_id = '30000000-0000-4000-8000-000000000025';

    insert into public.skip_trace_cache(value) values ('synthetic');
    insert into public.saved_filters(
      org_id, user_id, name, filters_json, is_base
    ) values (
      '00000000-0000-0000-0000-000000000bbb',
      '30000000-0000-4000-8000-000000000001',
      'synthetic',
      '{}'::jsonb,
      false
    ), (
      '00000000-0000-0000-0000-000000000bbb',
      null,
      'synthetic-base',
      '{}'::jsonb,
      true
    );
    insert into public.user_oauth_tokens(
      user_id, provider, token_type, access_token_encrypted
    ) values (
      '30000000-0000-4000-8000-000000000001',
      'google',
      'user',
      '\\x00'
    ), (
      '30000000-0000-4000-8000-000000000002',
      'google',
      'user',
      '\\x00'
    );
    insert into public.user_integration_prefs(user_id, channel)
    values (
      '30000000-0000-4000-8000-000000000001',
      'google_calendar'
    ), (
      '30000000-0000-4000-8000-000000000002',
      'google_calendar'
    );
    insert into public.metric_snapshots(metric_key) values ('synthetic');
    insert into public.counties(name) values ('Synthetic County');
    insert into public.fips_codes(code) values ('00000');
    insert into public.zip_county_xref(zip) values ('00000');
  `);

  const visibleMemberships = sql(
    port,
    cluster,
    `
      set role authenticated;
      select set_config('request.jwt.claim.role', 'authenticated', false);
      select set_config(
        'request.jwt.claim.sub',
        '30000000-0000-4000-8000-000000000001',
        false
      );
      select count(*) from public.memberships
      where user_id = '30000000-0000-4000-8000-000000000001';
    `,
    { capture: true, extraArgs: ["-Atq"] },
  ).trim().split("\n").at(-1);
  if (visibleMemberships !== "0") {
    throw new Error(
      `Suspended membership remained visible through RLS: ${visibleMemberships}`,
    );
  }

  const suspendedPolicyVisibility = sql(
    port,
    cluster,
    `
      set role authenticated;
      select set_config('request.jwt.claim.role', 'authenticated', false);
      select set_config(
        'request.jwt.claim.sub',
        '30000000-0000-4000-8000-000000000001',
        false
      );
      select
        (select count(*) from public.skip_trace_cache) || '|' ||
        (select count(*) from public.saved_filters) || '|' ||
        (select count(*) from public.user_oauth_tokens) || '|' ||
        (select count(*) from public.user_integration_prefs) || '|' ||
        (select count(*) from public.metric_snapshots) || '|' ||
        (select count(*) from public.counties) || '|' ||
        (select count(*) from public.fips_codes) || '|' ||
        (select count(*) from public.zip_county_xref);
    `,
    { capture: true, extraArgs: ["-Atq"] },
  ).trim().split("\n").at(-1);
  if (suspendedPolicyVisibility !== "0|0|0|0|0|0|0|0") {
    throw new Error(
      `Suspended direct-policy data remained visible: ${suspendedPolicyVisibility}`,
    );
  }

  for (const [fixture, userId] of [
    ["expired", "30000000-0000-4000-8000-000000000024"],
    ["deleting", "30000000-0000-4000-8000-000000000025"],
  ]) {
    const policyVisibility = sql(
      port,
      cluster,
      `
        set role authenticated;
        select set_config('request.jwt.claim.role', 'authenticated', false);
        select set_config('request.jwt.claim.sub', '${userId}', false);
        select
          (select count(*) from public.skip_trace_cache) || '|' ||
          (select count(*) from public.saved_filters) || '|' ||
          (select count(*) from public.user_oauth_tokens) || '|' ||
          (select count(*) from public.user_integration_prefs) || '|' ||
          (select count(*) from public.metric_snapshots) || '|' ||
          (select count(*) from public.counties) || '|' ||
          (select count(*) from public.fips_codes) || '|' ||
          (select count(*) from public.zip_county_xref);
      `,
      { capture: true, extraArgs: ["-Atq"] },
    ).trim().split("\n").at(-1);
    if (policyVisibility !== "0|0|0|0|0|0|0|0") {
      throw new Error(
        `${fixture} direct-policy data remained visible: ${policyVisibility}`,
      );
    }
  }

  sql(port, cluster, `
    set role authenticated;
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config(
      'request.jwt.claim.sub',
      '30000000-0000-4000-8000-000000000001',
      false
    );
    do $$
    declare
      v_count integer;
    begin
      begin
        insert into public.saved_filters(
          org_id, user_id, name, filters_json, is_base
        ) values (
          '00000000-0000-0000-0000-000000000bbb',
          '30000000-0000-4000-8000-000000000001',
          'blocked',
          '{}'::jsonb,
          false
        );
        raise exception 'suspended saved-filter insert unexpectedly succeeded';
      exception when insufficient_privilege then null;
      end;
      update public.saved_filters set name = 'blocked-update'
      where user_id = '30000000-0000-4000-8000-000000000001';
      get diagnostics v_count = row_count;
      assert v_count = 0, 'suspended saved-filter update reached a row';
      delete from public.saved_filters
      where user_id = '30000000-0000-4000-8000-000000000001';
      get diagnostics v_count = row_count;
      assert v_count = 0, 'suspended saved-filter delete reached a row';

      begin
        insert into public.user_integration_prefs(user_id, channel)
        values (
          '30000000-0000-4000-8000-000000000001',
          'slack'
        );
        raise exception 'suspended integration-pref insert unexpectedly succeeded';
      exception when insufficient_privilege then null;
      end;
      update public.user_integration_prefs set enabled = false
      where user_id = '30000000-0000-4000-8000-000000000001';
      get diagnostics v_count = row_count;
      assert v_count = 0, 'suspended integration-pref update reached a row';
      delete from public.user_integration_prefs
      where user_id = '30000000-0000-4000-8000-000000000001';
      get diagnostics v_count = row_count;
      assert v_count = 0, 'suspended integration-pref delete reached a row';
    end $$;
    reset role;
  `);

  sql(port, cluster, `
    select set_config('request.jwt.claim.role', 'service_role', false);
    insert into auth.users(id, email) values
      ('30000000-0000-4000-8000-000000000021',
       'config.member@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000022',
       'duplicate@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000023',
       'DUPLICATE@BMHGROUPKC.COM'),
      ('30000000-0000-4000-8000-000000000027',
       'lost.response@bmhgroupkc.com');

    do $$
    declare
      v jsonb;
      v_first_failure jsonb;
      v_prior_receipt jsonb;
    begin
      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000001',
        'config.member@bmhgroupkc.com',
        'member',
        '{"cohort":"alpha"}'::jsonb,
        'active',
        now() + interval '1 day'
      );
      assert v->>'proceed' = 'true';
      v := public.hugo_apply_access(
        '50000000-0000-4000-8000-000000000001',
        'config.member@bmhgroupkc.com',
        'member',
        '{"cohort":"alpha"}'::jsonb,
        'active',
        now() + interval '1 day'
      );
      assert (v->>'ok')::boolean, 'initial config grant failed';

      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000002',
        'config.member@bmhgroupkc.com',
        'member',
        '{"cohort":"beta","timezone":"America/Chicago"}'::jsonb,
        'active',
        now() + interval '2 days'
      );
      assert v->>'proceed' = 'true';
      v := public.hugo_apply_access(
        '50000000-0000-4000-8000-000000000002',
        'config.member@bmhgroupkc.com',
        'member',
        '{"cohort":"beta","timezone":"America/Chicago"}'::jsonb,
        'active',
        now() + interval '2 days'
      );
      assert (v->>'ok')::boolean, 'same-role config/expiry update failed';
      assert (
        select m.hugo_config =
          '{"cohort":"beta","timezone":"America/Chicago"}'::jsonb
          and m.access_expires_at > now() + interval '1 day 23 hours'
        from public.memberships m
        where m.user_id = '30000000-0000-4000-8000-000000000021'
      ), 'same-role config/expiry state did not change';
      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000006',
        'config.member@bmhgroupkc.com',
        'member',
        '{"cohort":"beta","timezone":"America/Chicago"}'::jsonb,
        'suspended',
        now() + interval '2 days'
      );
      assert v->>'proceed' = 'true';
      v := public.hugo_apply_access(
        '50000000-0000-4000-8000-000000000006',
        'config.member@bmhgroupkc.com',
        'member',
        '{"cohort":"beta","timezone":"America/Chicago"}'::jsonb,
        'suspended',
        now() + interval '2 days'
      );
      assert (v->>'ok')::boolean, 'suspended RPC fixture failed';

      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000003',
        'auth.failure@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'true', 'Auth failure preflight failed';
      v_first_failure := public.hugo_record_identity_provision_failure(
        '50000000-0000-4000-8000-000000000003',
        'auth.failure@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v_first_failure->>'error_code' = 'IDENTITY_PROVISION_FAILED';
      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000003',
        'auth.failure@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'false';
      assert v->'receipt' = v_first_failure,
        'exact Auth failure preflight did not replay the receipt';
      v := public.hugo_record_identity_provision_failure(
        '50000000-0000-4000-8000-000000000003',
        'auth.failure@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v = v_first_failure,
        'exact Auth failure recorder changed the receipt';
      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000003',
        'auth.failure@bmhgroupkc.com',
        'owner',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->'receipt'->>'error_code' = 'OPERATION_CONFLICT',
        'changed Auth failure retry did not conflict';

      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000007',
        'lost.response@bmhgroupkc.com',
        'member',
        '{"cohort":"alpha"}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'true',
        'lost Auth response preflight failed';
      v_first_failure := public.hugo_record_identity_provision_failure(
        '50000000-0000-4000-8000-000000000007',
        'lost.response@bmhgroupkc.com',
        'member',
        '{"cohort":"alpha"}'::jsonb,
        'active',
        null
      );
      assert (v_first_failure->>'ok')::boolean,
        'unique committed Auth identity was terminalized as a failure';
      assert v_first_failure->>'app_user_id' =
        '30000000-0000-4000-8000-000000000027',
        'lost Auth response reconciled the wrong identity';
      assert exists (
        select 1
        from public.memberships m
        where m.user_id =
          '30000000-0000-4000-8000-000000000027'::uuid
          and m.role = 'member'
          and m.access_status = 'active'
      ), 'lost Auth response did not apply the reserved access grant';
      v := public.hugo_record_identity_provision_failure(
        '50000000-0000-4000-8000-000000000007',
        'lost.response@bmhgroupkc.com',
        'member',
        '{"cohort":"alpha"}'::jsonb,
        'active',
        null
      );
      assert v = v_first_failure,
        'lost Auth response exact retry changed the success receipt';
      v := public.hugo_record_identity_provision_failure(
        '50000000-0000-4000-8000-000000000007',
        'lost.response@bmhgroupkc.com',
        'owner',
        '{"cohort":"alpha"}'::jsonb,
        'active',
        null
      );
      assert v->>'error_code' = 'OPERATION_CONFLICT',
        'lost Auth response changed retry did not conflict';

      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000004',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'true';
      v := public.hugo_apply_access(
        '50000000-0000-4000-8000-000000000004',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'active',
        null
      );
      assert (v->>'ok')::boolean, 'owner reactivation fixture failed';

      v := public.hugo_preflight_access_operation(
        '50000000-0000-4000-8000-000000000005',
        'owner.two@bmhgroupkc.com',
        'owner',
        '{}'::jsonb,
        'active',
        now() + interval '3 days'
      );
      assert v->>'proceed' = 'true';
      v := public.hugo_apply_access(
        '50000000-0000-4000-8000-000000000005',
        'owner.two@bmhgroupkc.com',
        'owner',
        '{}'::jsonb,
        'active',
        now() + interval '3 days'
      );
      assert (v->>'ok')::boolean, 'finite-owner retry fixture failed';

      select op.receipt into v_prior_receipt
      from public.hugo_access_operations op
      where op.operation_id =
        '20000000-0000-4000-8000-000000000005'::uuid;
      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000005',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'suspended',
        null
      );
      assert v = v_prior_receipt,
        'exact apply retry was re-evaluated against current owner state';
      assert (
        select m.access_status = 'active'
        from public.memberships m
        where m.user_id = '30000000-0000-4000-8000-000000000001'
      ), 'exact apply retry mutated current access state';

      begin
        perform public.hugo_find_user_id('duplicate@bmhgroupkc.com');
        raise exception 'ambiguous identity unexpectedly resolved';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'HUGO_IDENTITY_AMBIGUOUS' then raise; end if;
      end;
    end $$;
  `);

  sql(port, cluster, `
    select set_config('request.jwt.claim.role', 'service_role', false);
    insert into public.organizations(id, name) values
      ('00000000-0000-0000-0000-000000000ccc', 'Concurrency Fixture'),
      ('00000000-0000-0000-0000-000000000ddd', 'Bootstrap Fixture'),
      ('00000000-0000-0000-0000-000000000eee', 'Repeatable Read Fixture');
    insert into auth.users(id, email) values
      ('30000000-0000-4000-8000-000000000011', 'owner.a@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000012', 'owner.b@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000013', 'member.c@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000014', 'owner.d@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000015', 'owner.e@bmhgroupkc.com'),
      ('30000000-0000-4000-8000-000000000016', 'owner.f@bmhgroupkc.com');

    insert into public.memberships(user_id, org_id, role)
    values (
      '30000000-0000-4000-8000-000000000011',
      '00000000-0000-0000-0000-000000000ccc',
      'owner'
    ), (
      '30000000-0000-4000-8000-000000000012',
      '00000000-0000-0000-0000-000000000ccc',
      'owner'
    ), (
      '30000000-0000-4000-8000-000000000015',
      '00000000-0000-0000-0000-000000000eee',
      'owner'
    ), (
      '30000000-0000-4000-8000-000000000016',
      '00000000-0000-0000-0000-000000000eee',
      'owner'
    );

    do $$
    begin
      update public.memberships
      set access_expires_at = now() + interval '10 years'
      where user_id = '30000000-0000-4000-8000-000000000011';
      begin
        update public.memberships
        set access_expires_at = now() + interval '20 years'
        where user_id = '30000000-0000-4000-8000-000000000012';
        raise exception 'all-finite owners unexpectedly succeeded';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'FINAL_OWNER_GUARD' then raise; end if;
      end;
      update public.memberships
      set access_expires_at = null
      where user_id = '30000000-0000-4000-8000-000000000011';

      insert into public.memberships(user_id, org_id, role)
      values (
        '30000000-0000-4000-8000-000000000013',
        '00000000-0000-0000-0000-000000000ccc',
        'member'
      );
      update public.memberships
      set role = 'owner', access_expires_at = now() + interval '30 years'
      where user_id = '30000000-0000-4000-8000-000000000013';
      delete from public.memberships
      where user_id = '30000000-0000-4000-8000-000000000013';

      begin
        insert into public.memberships(
          user_id, org_id, role, access_expires_at
        ) values (
          '30000000-0000-4000-8000-000000000014',
          '00000000-0000-0000-0000-000000000ddd',
          'owner',
          now() + interval '30 years'
        );
        raise exception 'finite bootstrap owner unexpectedly succeeded';
      exception
        when sqlstate 'P0001' then
          if sqlerrm <> 'FINAL_OWNER_GUARD' then raise; end if;
      end;
      insert into public.memberships(user_id, org_id, role)
      values (
        '30000000-0000-4000-8000-000000000014',
        '00000000-0000-0000-0000-000000000ddd',
        'owner'
      );
    end $$;
  `);

  const concurrentOwnerUpdates = await Promise.allSettled([
    sqlAsync(port, cluster, `
      begin;
      select set_config('request.jwt.claim.role', 'service_role', false);
      update public.memberships
      set role = 'member'
      where user_id = '30000000-0000-4000-8000-000000000011';
      select pg_sleep(0.25);
      commit;
    `),
    sqlAsync(port, cluster, `
      begin;
      select set_config('request.jwt.claim.role', 'service_role', false);
      update public.memberships
      set role = 'member'
      where user_id = '30000000-0000-4000-8000-000000000012';
      commit;
    `),
  ]);
  const ownerUpdateSuccesses = concurrentOwnerUpdates.filter(
    (result) => result.status === "fulfilled",
  ).length;
  const ownerUpdateFailures = concurrentOwnerUpdates.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof Error &&
      result.reason.message.includes("FINAL_OWNER_GUARD"),
  ).length;
  if (ownerUpdateSuccesses !== 1 || ownerUpdateFailures !== 1) {
    throw new Error(
      `Concurrent final-owner guard mismatch: ${JSON.stringify(
        concurrentOwnerUpdates.map((result) =>
          result.status === "fulfilled" ? "fulfilled" : result.reason.message
        ),
      )}`,
    );
  }

  const remainingPermanentOwners = sql(
    port,
    cluster,
    `
      select count(*)
      from public.memberships
      where org_id = '00000000-0000-0000-0000-000000000ccc'
        and role = 'owner'
        and access_status = 'active'
        and deletion_prepared_at is null
        and access_expires_at is null;
    `,
    { capture: true, extraArgs: ["-Atq"] },
  ).trim();
  if (remainingPermanentOwners !== "1") {
    throw new Error(
      `Concurrent owner transitions left ${remainingPermanentOwners} permanent owners`,
    );
  }

  const repeatableReadOwnerUpdates = await Promise.allSettled([
    sqlAsync(port, cluster, `
      begin isolation level repeatable read;
      select set_config('request.jwt.claim.role', 'service_role', false);
      select count(*) from public.memberships;
      update public.memberships
      set role = 'member'
      where user_id = '30000000-0000-4000-8000-000000000015';
      select pg_sleep(0.75);
      commit;
    `),
    sqlAsync(port, cluster, `
      begin isolation level repeatable read;
      select set_config('request.jwt.claim.role', 'service_role', false);
      select count(*) from public.memberships;
      select pg_sleep(0.1);
      update public.memberships
      set role = 'member'
      where user_id = '30000000-0000-4000-8000-000000000016';
      commit;
    `),
  ]);
  const repeatableReadSuccesses = repeatableReadOwnerUpdates.filter(
    (result) => result.status === "fulfilled",
  ).length;
  const repeatableReadFailures = repeatableReadOwnerUpdates.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof Error &&
      (
        result.reason.message.includes("could not serialize access") ||
        result.reason.message.includes("FINAL_OWNER_GUARD")
      ),
  ).length;
  if (repeatableReadSuccesses !== 1 || repeatableReadFailures !== 1) {
    throw new Error(
      `Repeatable-read owner guard mismatch: ${JSON.stringify(
        repeatableReadOwnerUpdates.map((result) =>
          result.status === "fulfilled" ? "fulfilled" : result.reason.message
        ),
      )}`,
    );
  }
  const repeatableReadPermanentOwners = sql(
    port,
    cluster,
    `
      select count(*)
      from public.memberships
      where org_id = '00000000-0000-0000-0000-000000000eee'
        and role = 'owner'
        and access_status = 'active'
        and deletion_prepared_at is null
        and access_expires_at is null;
    `,
    { capture: true, extraArgs: ["-Atq"] },
  ).trim();
  if (repeatableReadPermanentOwners !== "1") {
    throw new Error(
      `Repeatable-read transitions left ${repeatableReadPermanentOwners} permanent owners`,
    );
  }

  sql(port, cluster, `
    set role authenticated;
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config(
      'request.jwt.claim.sub',
      '30000000-0000-4000-8000-000000000002',
      false
    );
    do $$
    declare
      v_count integer;
    begin
      assert (select count(*) from public.skip_trace_cache) = 1;
      assert (select count(*) from public.saved_filters) = 1;
      assert (select count(*) from public.user_oauth_tokens) = 1;
      assert (select count(*) from public.user_integration_prefs) = 1;
      assert (select count(*) from public.metric_snapshots) = 1;
      assert (select count(*) from public.counties) = 1;
      assert (select count(*) from public.fips_codes) = 1;
      assert (select count(*) from public.zip_county_xref) = 1;

      insert into public.saved_filters(
        org_id, user_id, name, filters_json, is_base
      ) values (
        '00000000-0000-0000-0000-000000000bbb',
        '30000000-0000-4000-8000-000000000002',
        'active-write',
        '{}'::jsonb,
        false
      );
      update public.saved_filters set name = 'active-updated'
      where user_id = '30000000-0000-4000-8000-000000000002';
      get diagnostics v_count = row_count;
      assert v_count = 1, 'active saved-filter update was blocked';
      delete from public.saved_filters
      where user_id = '30000000-0000-4000-8000-000000000002';
      get diagnostics v_count = row_count;
      assert v_count = 1, 'active saved-filter delete was blocked';

      insert into public.user_integration_prefs(user_id, channel)
      values (
        '30000000-0000-4000-8000-000000000002',
        'slack'
      );
      update public.user_integration_prefs set enabled = false
      where user_id = '30000000-0000-4000-8000-000000000002'
        and channel = 'slack';
      get diagnostics v_count = row_count;
      assert v_count = 1, 'active integration-pref update was blocked';
      delete from public.user_integration_prefs
      where user_id = '30000000-0000-4000-8000-000000000002'
        and channel = 'slack';
      get diagnostics v_count = row_count;
      assert v_count = 1, 'active integration-pref delete was blocked';
    end $$;
    reset role;
  `);

  sql(port, cluster, `
    set role authenticated;
    select set_config('request.jwt.claim.role', 'authenticated', false);
      select set_config(
        'request.jwt.claim.sub',
        '30000000-0000-4000-8000-000000000021',
        false
      );
    do $$
    begin
      begin
        perform public.delete_contact(
          '10000000-0000-4000-8000-000000000001',
          'synthetic'
        );
        raise exception 'suspended SECURITY DEFINER action unexpectedly succeeded';
      exception
        when insufficient_privilege then null;
      end;
    end $$;
    reset role;
  `);

  sql(port, cluster, `
    select set_config('request.jwt.claim.role', 'service_role', false);
    insert into auth.users(id, email, last_sign_in_at) values
      ('30000000-0000-4000-8000-000000000003',
       'pristine@bmhgroupkc.com', null),
      ('30000000-0000-4000-8000-000000000004',
       'signed.in@bmhgroupkc.com', now()),
      ('30000000-0000-4000-8000-000000000005',
       'durable@bmhgroupkc.com', null),
      ('30000000-0000-4000-8000-000000000026',
       'race.delete@bmhgroupkc.com', null);
    insert into public.memberships(user_id, org_id, role) values
      ('30000000-0000-4000-8000-000000000004',
       '00000000-0000-0000-0000-000000000bbb', 'member'),
      ('30000000-0000-4000-8000-000000000005',
       '00000000-0000-0000-0000-000000000bbb', 'member'),
      ('30000000-0000-4000-8000-000000000026',
       '00000000-0000-0000-0000-000000000bbb', 'member');
    insert into public.user_activity(actor_user_id)
    values ('30000000-0000-4000-8000-000000000005');
    create table public.hugo_test_delete_race_receipts (
      receipt jsonb not null
    );

    do $$
    declare
      v jsonb;
      v_replay jsonb;
    begin
      v := public.hugo_preflight_access_operation(
        '40000000-0000-4000-8000-000000000009',
        'pristine@bmhgroupkc.com',
        'member',
        '{}'::jsonb,
        'active',
        null
      );
      assert v->>'proceed' = 'true',
        'pristine identity claim fixture failed';

      v := public.hugo_delete_identity(
        '40000000-0000-4000-8000-000000000001',
        'pristine@bmhgroupkc.com'
      );
      assert v->>'error_code' = 'PRISTINE_DELETE_REQUIRED',
        'delete without prepare proof was not rejected';

      v := public.hugo_prepare_pristine_delete(
        '40000000-0000-4000-8000-000000000002',
        'pristine@bmhgroupkc.com'
      );
      assert (v->>'ok')::boolean, 'pristine prepare failed';
      v := public.hugo_delete_identity(
        '40000000-0000-4000-8000-000000000003',
        'pristine@bmhgroupkc.com'
      );
      assert (v->>'ok')::boolean, 'prepared pristine delete failed';
      assert not exists (
        select 1 from auth.users
        where id = '30000000-0000-4000-8000-000000000003'
      ), 'prepared Auth user still exists';
      assert v->>'app_user_id' <>
        '30000000-0000-4000-8000-000000000003',
        'delete receipt retained the Auth UUID';

      v_replay := public.hugo_delete_identity(
        '40000000-0000-4000-8000-000000000003',
        'pristine@bmhgroupkc.com'
      );
      assert v_replay = v,
        'exact delete retry changed its stored receipt: first=' ||
        v::text || ' replay=' || v_replay::text;
      v_replay := public.hugo_delete_identity(
        '40000000-0000-4000-8000-000000000003',
        'changed-pristine@bmhgroupkc.com'
      );
      assert v_replay->>'error_code' = 'OPERATION_CONFLICT',
        'changed delete retry did not conflict';

      assert not exists (
        select 1
        from public.hugo_access_operations op
        where lower(op.email) = 'pristine@bmhgroupkc.com'
           or op.app_user_id =
             '30000000-0000-4000-8000-000000000003'::uuid
           or position(
             'pristine@bmhgroupkc.com' in op.requested::text
           ) > 0
           or position(
             'pristine@bmhgroupkc.com' in op.receipt::text
           ) > 0
           or position(
             '30000000-0000-4000-8000-000000000003'
             in op.requested::text
           ) > 0
           or position(
             '30000000-0000-4000-8000-000000000003'
             in op.receipt::text
           ) > 0
      ), 'operation evidence retained exact deleted identity';
      assert not exists (
        select 1
        from public.hugo_access_operation_claims claim
        where lower(claim.email) = 'pristine@bmhgroupkc.com'
           or position(
             'pristine@bmhgroupkc.com' in claim.requested::text
           ) > 0
           or position(
             '30000000-0000-4000-8000-000000000003'
             in claim.requested::text
           ) > 0
      ), 'claim evidence retained exact deleted identity';
      assert (
        select count(*)
        from public.hugo_access_operations op
        where op.operation_id in (
          '40000000-0000-4000-8000-000000000002'::uuid,
          '40000000-0000-4000-8000-000000000003'::uuid
        )
          and op.request_hash ~ '^[0-9a-f]{64}$'
      ) = 2, 'deletion lost operation/hash retry evidence';

      v := public.hugo_prepare_pristine_delete(
        '40000000-0000-4000-8000-000000000004',
        'signed.in@bmhgroupkc.com'
      );
      assert v->>'error_code' = 'NON_PRISTINE',
        'prior sign-in did not block hard deletion';

      v := public.hugo_prepare_pristine_delete(
        '40000000-0000-4000-8000-000000000005',
        'durable@bmhgroupkc.com'
      );
      assert v->>'error_code' = 'NON_PRISTINE',
        'dynamic durable reference did not block hard deletion';

      v := public.hugo_prepare_pristine_delete(
        '60000000-0000-4000-8000-000000000001',
        'race.delete@bmhgroupkc.com'
      );
      assert (v->>'ok')::boolean,
        'durable-reference race identity prepare failed';
    end $$;
  `);

  const inFlightDurableActivity = sqlAsync(port, cluster, `
    set application_name = 'hugo-hard-delete-durable-race';
    begin;
    select set_config('request.jwt.claim.role', 'service_role', false);
    insert into public.user_activity(actor_user_id)
    values ('30000000-0000-4000-8000-000000000026');
    select pg_sleep(1);
    commit;
  `);
  await waitForActiveQuery(
    port,
    cluster,
    "hugo-hard-delete-durable-race",
  );
  const racedHardDelete = sqlAsync(port, cluster, `
    begin;
    select set_config('request.jwt.claim.role', 'service_role', false);
    insert into public.hugo_test_delete_race_receipts(receipt)
    select public.hugo_delete_identity(
      '60000000-0000-4000-8000-000000000002',
      'race.delete@bmhgroupkc.com'
    );
    commit;
  `);
  const hardDeleteRace = await Promise.allSettled([
    inFlightDurableActivity,
    racedHardDelete,
  ]);
  if (hardDeleteRace.some((result) => result.status === "rejected")) {
    throw new Error(
      `Hard-delete durable-reference race failed: ${JSON.stringify(
        hardDeleteRace.map((result) =>
          result.status === "fulfilled" ? "fulfilled" : result.reason.message
        ),
      )}`,
    );
  }
  const hardDeleteRaceResult = sql(
    port,
    cluster,
    `
      select
        (select receipt->>'error_code'
         from public.hugo_test_delete_race_receipts) || '|' ||
        (select count(*)
         from auth.users
         where id =
           '30000000-0000-4000-8000-000000000026'::uuid) || '|' ||
        (select count(*)
         from public.user_activity
         where actor_user_id =
           '30000000-0000-4000-8000-000000000026'::uuid);
    `,
    { capture: true, extraArgs: ["-Atq"] },
  ).trim();
  if (hardDeleteRaceResult !== "NON_PRISTINE|1|1") {
    throw new Error(
      `Hard-delete durable-reference race escaped: ${hardDeleteRaceResult}`,
    );
  }

  const privileges = sql(
    port,
    cluster,
    `
      select
        has_function_privilege(
          'service_role',
          'public.hugo_preflight_access_operation(uuid,text,text,jsonb,text,timestamptz)',
          'EXECUTE'
        ) || '|' ||
        has_function_privilege(
          'authenticated',
          'public.hugo_preflight_access_operation(uuid,text,text,jsonb,text,timestamptz)',
          'EXECUTE'
        ) || '|' ||
        has_function_privilege(
          'authenticated',
          'public.hugo_apply_access(uuid,text,text,jsonb,text,timestamptz)',
          'EXECUTE'
        ) || '|' ||
        has_function_privilege(
          'service_role',
          'public.hugo_record_identity_provision_failure(uuid,text,text,jsonb,text,timestamptz)',
          'EXECUTE'
        ) || '|' ||
        has_function_privilege(
          'authenticated',
          'public.hugo_record_identity_provision_failure(uuid,text,text,jsonb,text,timestamptz)',
          'EXECUTE'
        ) || '|' ||
        has_table_privilege(
          'service_role',
          'public.hugo_access_operations',
          'INSERT'
        ) || '|' ||
        has_table_privilege(
          'service_role',
          'public.hugo_access_operation_claims',
          'INSERT'
        );
    `,
    { capture: true, extraArgs: ["-Atq"] },
  ).trim();
  if (privileges !== "true|false|false|true|false|false|false") {
    throw new Error(`Unexpected Hugo connector grants: ${privileges}`);
  }

  console.log(JSON.stringify({
    ok: true,
    lane,
    postgres: 17,
    migrations: migrationNames,
    hostedSnapshotSourceCommit:
      lane === "hosted-snapshot-forward"
        ? hostedSnapshotSourceCommit
        : null,
    forwardReplay: 2,
    assertions: {
      hostedSnapshotHash: lane === "hosted-snapshot-forward" ? "pass" : "n/a",
      invalidReceiptBinding: "pass",
      invalidRequestRedaction: "pass",
      preflightConflictBeforeAuth: "pass",
      applyRequiresPreflight: "pass",
      receiptBinding: "pass",
      authFailureReceiptReplay: "pass",
      authLostResponseReconciliation: "pass",
      applyRetryOrdering: "pass",
      configExpiryApply: "pass",
      permanentOwnerInvariant: "pass",
      concurrentOwnerTransitions: "pass",
      repeatableReadOwnerTransitions: "pass",
      suspendedRls: "pass",
      directPolicyMatrix: "pass",
      suspendedSecurityDefinerRpc: "pass",
      pristinePrepareProof: "pass",
      hardDeletePseudonymization: "pass",
      hardDeleteDurableReferenceRace: "pass",
      priorSignIn: "pass",
      dynamicDurableActivity: "pass",
      privileges,
    },
  }));
} finally {
  if (started) {
    try {
      run("pg_ctl", ["-D", cluster, "-m", "fast", "stop"], {
        stdio: "ignore",
      });
    } catch {
      // Preserve the migration or assertion error if shutdown also fails.
    }
  }
  await rm(cluster, { recursive: true, force: true });
}
