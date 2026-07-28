#!/usr/bin/env node

/**
 * Replay Sandra's Hugo migrations against a disposable PostgreSQL 17 cluster.
 * The fixture models only the pre-Hugo Supabase objects these migrations touch;
 * it never connects to a hosted project.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationNames = [
  "20260727150000_hugo_access_provisioner.sql",
  "20260728090000_hugo_access_inventory.sql",
  "20260728110000_hugo_auth_hard_delete.sql",
  "20260728130000_hugo_access_operation_request_hash.sql",
  "20260728150000_hugo_access_authorization_hardening.sql",
];
const migrations = migrationNames.map((name) =>
  join(root, "supabase", "migrations", name),
);
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
    create extension if not exists pgcrypto;
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
      actor_user_id uuid references auth.users(id)
    );

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
      { stdio: "ignore" },
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
    { stdio: "ignore" },
  );

  sql(port, cluster, `
    select set_config('request.jwt.claim.role', 'service_role', false);

    do $$
    declare
      v jsonb;
    begin
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
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'suspended',
        null
      );
      assert v->>'proceed' = 'true', 'owner suspension preflight failed';
      v := public.hugo_apply_access(
        '20000000-0000-4000-8000-000000000004',
        'owner.one@bmhgroupkc.com',
        'owner',
        '{"timezone":"America/Chicago"}'::jsonb,
        'suspended',
        null
      );
      assert (v->>'ok')::boolean, 'safe owner suspension failed';
    end $$;
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

  sql(port, cluster, `
    set role authenticated;
    select set_config('request.jwt.claim.role', 'authenticated', false);
    select set_config(
      'request.jwt.claim.sub',
      '30000000-0000-4000-8000-000000000001',
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
       'durable@bmhgroupkc.com', null);
    insert into public.memberships(user_id, org_id, role) values
      ('30000000-0000-4000-8000-000000000004',
       '00000000-0000-0000-0000-000000000bbb', 'member'),
      ('30000000-0000-4000-8000-000000000005',
       '00000000-0000-0000-0000-000000000bbb', 'member');
    insert into public.user_activity(actor_user_id)
    values ('30000000-0000-4000-8000-000000000005');

    do $$
    declare
      v jsonb;
    begin
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
    end $$;
  `);

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
        );
    `,
    { capture: true, extraArgs: ["-Atq"] },
  ).trim();
  if (privileges !== "true|false|false") {
    throw new Error(`Unexpected Hugo connector grants: ${privileges}`);
  }

  console.log(JSON.stringify({
    ok: true,
    postgres: 17,
    migrations: migrationNames,
    forwardReplay: 2,
    assertions: {
      preflightConflictBeforeAuth: "pass",
      receiptBinding: "pass",
      finalOwnerExpiry: "pass",
      suspendedRls: "pass",
      suspendedSecurityDefinerRpc: "pass",
      pristinePrepareProof: "pass",
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
