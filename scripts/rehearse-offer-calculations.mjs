#!/usr/bin/env node
// Rehearse offer_calculations against a disposable, host-only PostgreSQL
// cluster. This never connects to a hosted Supabase project.

import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const cluster = mkdtempSync(join(tmpdir(), "sandra-offer-calculations-"));
const socketDir = mkdtempSync("/tmp/socs-");
const port = 7600 + Math.floor(Math.random() * 250);
const migration = fileURLToPath(
  new URL("../supabase/migrations/20260916090000_offer_calculations.sql", import.meta.url),
);
let started = false;

const ids = {
  orgA: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgB: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  owner: "11111111-1111-4111-8111-111111111111",
  rep: "22222222-2222-4222-8222-222222222222",
  other: "33333333-3333-4333-8333-333333333333",
  reader: "99999999-9999-4999-8999-999999999999",
  propertyA: "44444444-4444-4444-8444-444444444444",
  propertyA2: "55555555-5555-4555-8555-555555555555",
  propertyB: "66666666-6666-4666-8666-666666666666",
  keeper: "77777777-7777-4777-8777-777777777777",
  loser: "88888888-8888-4888-8888-888888888888",
  overlapKeeper: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab",
  overlapLoser: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc",
};

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

function psql(sql) {
  return execFileSync(
    "psql",
    ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function psqlAsync(sql) {
  return new Promise((resolve, reject) => {
    execFile(
      "psql",
      ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", `set statement_timeout='5000ms'; ${sql}`],
      { encoding: "utf8" },
      (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim()),
    );
  });
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function expectRejected(sql, pattern, label) {
  try {
    psql(sql);
  } catch (error) {
    const detail = `${String(error)}\n${error?.stderr?.toString?.() ?? ""}`;
    if (pattern.test(detail)) return;
    throw new Error(`${label}: wrong rejection: ${detail}`);
  }
  throw new Error(`${label}: unexpectedly succeeded`);
}

function json(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

const decision = {
  approach: "novation",
  program: "equity_protection",
  feeTier: 40000,
  proposedOffer: 125000,
  terms: "cash at close",
  motivation: "relocation",
};
const provenance = { source: "lead_calculations", leadId: ids.propertyA };
const inputs = { asIs: 140000, listingPercentage: 0.9, repairs: 12000 };
const results = { investor: 98000, offers: { fee40000: 58000 } };
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const hashC = "c".repeat(64);
const hashD = "d".repeat(64);
const hashE = "e".repeat(64);
const hashH = "1".repeat(64);
const hashI = "2".repeat(64);
const hashL = "5".repeat(64);
const worksheetSha256 = "1017cc7835ae7f41a8d32e3228b9510fe01697c4a018f22b86df7c1061a4bdf8";
const requestA = "90000000-0000-4000-8000-000000000001";
const requestB = "90000000-0000-4000-8000-000000000002";
const requestC = "90000000-0000-4000-8000-000000000003";
const requestD = "90000000-0000-4000-8000-000000000004";
const requestE = "90000000-0000-4000-8000-000000000005";
const requestF = "90000000-0000-4000-8000-000000000006";
const requestG = "90000000-0000-4000-8000-000000000007";
const requestH = "90000000-0000-4000-8000-000000000008";
const requestI = "90000000-0000-4000-8000-000000000009";
const requestJ = "90000000-0000-4000-8000-000000000010";
const requestK = "90000000-0000-4000-8000-000000000011";
const requestL = "90000000-0000-4000-8000-000000000012";

const service = "set role service_role; set request.jwt.claim.role='service_role';";
const actor = (userId) => `${service} select public.fn_save_offer_calculation('${userId}',`;
const saveSql = ({ userId = ids.owner, propertyId = ids.propertyA, requestId, requestHash, parentId = null, input = inputs } = {}) =>
  `${actor(userId)}'${propertyId}',${json(input)},${json(results)},${json(decision)},${json({ ...provenance, leadId: propertyId })},'closr-v1','${requestId}','${requestHash}',${parentId ? `'${parentId}'` : "null"});`;
const saveRpcSql = (options = {}) => saveSql(options).slice(service.length);

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function connectPgClient() {
  const client = new Client({ host: socketDir, port, user: "postgres", database: "postgres" });
  await client.connect();
  return client;
}

async function waitForLockWait(activityClient, pid, label) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await activityClient.query(
      "select wait_event_type, wait_event, state from pg_stat_activity where pid = $1",
      [pid],
    );
    const row = result.rows[0];
    if (row?.wait_event_type === "Lock") return row;
    await wait(25);
  }
  throw new Error(`Timed out waiting for ${label} to report a PostgreSQL lock wait.`);
}

try {
  run("initdb", ["-D", cluster, "-A", "trust", "-U", "postgres", "--no-locale"], { stdio: "ignore", env: { ...process.env, LC_ALL: "C" } });
  run("pg_ctl", ["-D", cluster, "-o", `-p ${port} -k ${socketDir}`, "-l", join(cluster, "server.log"), "start"], { stdio: "ignore", env: { ...process.env, LC_ALL: "C" } });
  started = true;

  psql(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema extensions;
    create extension pgcrypto with schema extensions;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function auth.role() returns text language sql stable as $$
      select nullif(current_setting('request.jwt.claim.role', true), '')
    $$;
    create table auth.users(id uuid primary key);
    create table public.organizations(id uuid primary key);
    create table public.memberships(
      user_id uuid not null,
      org_id uuid not null references public.organizations(id) on delete cascade,
      role text not null,
      access_status text not null default 'active',
      deletion_prepared_at timestamptz,
      access_expires_at timestamptz,
      acquisitions_enabled boolean not null default false,
      primary key(user_id, org_id)
    );
    create table public.properties(
      id uuid primary key,
      org_id uuid not null,
      assigned_user_id uuid,
      status text not null default 'new_lead',
      deleted_at timestamptz,
      unique(id, org_id)
    );
    create table public.acquisition_org_settings(
      org_id uuid primary key,
      my_leads_enabled boolean not null default false
    );
    create table public.lead_events(
      id uuid primary key default extensions.gen_random_uuid(),
      org_id uuid not null references public.organizations(id) on delete cascade,
      property_id uuid not null,
      actor_type text not null,
      actor_id uuid,
      event_type text not null,
      payload jsonb not null default '{}'::jsonb,
      source_type text,
      source_id uuid,
      created_at timestamptz not null default now(),
      foreign key(property_id, org_id) references public.properties(id, org_id),
      constraint lead_events_actor_type_check
        check (actor_type in ('user', 'ai', 'system')),
      constraint lead_events_actor_identity_check
        check (actor_type = 'user' or actor_id is null),
      constraint lead_events_source_identity_check
        check ((source_type is null) = (source_id is null))
    );
    create unique index lead_events_source_identity_idx
      on public.lead_events(source_type, source_id) where source_id is not null;
    create table public.property_merges(
      id uuid primary key default extensions.gen_random_uuid(),
      org_id uuid not null,
      keeper_id uuid not null,
      loser_id uuid not null,
      merged_at timestamptz not null default now(),
      merged_by uuid,
      loser_snapshot jsonb not null
    );
    create table public.ai_disposition_reviews(property_id uuid, org_id uuid);
    create table public.esign_requests(property_id uuid, org_id uuid, updated_at timestamptz);
    create table public.lead_files(property_id uuid, org_id uuid);
    create or replace function public.hugo_has_active_org_access(p_org_id uuid)
      returns boolean language sql stable as $$ select true $$;
    create or replace function public.merge_duplicate_properties_hugo_unchecked(keeper_id uuid, loser_id uuid)
      returns void language plpgsql security definer set search_path=public,pg_temp as $$
      declare loser_row public.properties%rowtype;
      begin
        select * into loser_row from public.properties where id=loser_id;
        insert into public.property_merges(org_id,keeper_id,loser_id,merged_by,loser_snapshot)
          values(loser_row.org_id,keeper_id,loser_id,auth.uid(),to_jsonb(loser_row));
        delete from public.properties where id=loser_id;
      end
    $$;
    insert into auth.users values
      ('${ids.owner}'),('${ids.rep}'),('${ids.other}'),('${ids.reader}');
    insert into public.organizations values ('${ids.orgA}'),('${ids.orgB}');
    insert into public.memberships(user_id,org_id,role,acquisitions_enabled) values
      ('${ids.owner}','${ids.orgA}','owner',true),
      ('${ids.rep}','${ids.orgA}','member',true),
      ('${ids.reader}','${ids.orgA}','member',false),
      ('${ids.other}','${ids.orgB}','member',true);
    insert into public.acquisition_org_settings values ('${ids.orgA}',true),('${ids.orgB}',true);
    insert into public.properties(id,org_id,assigned_user_id,status) values
      ('${ids.propertyA}','${ids.orgA}','${ids.rep}','new_lead'),
      ('${ids.propertyA2}','${ids.orgA}',null,'new_lead'),
      ('${ids.propertyB}','${ids.orgB}','${ids.other}','new_lead'),
      ('${ids.keeper}','${ids.orgA}',null,'new_lead'),
      ('${ids.loser}','${ids.orgA}',null,'new_lead'),
      ('${ids.overlapKeeper}','${ids.orgA}',null,'new_lead'),
      ('${ids.overlapLoser}','${ids.orgA}',null,'new_lead');
    grant usage on schema public, auth, extensions to anon, authenticated, service_role;
    grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
    grant select on public.memberships, public.properties, public.acquisition_org_settings to authenticated;
    grant select, update on public.properties to service_role;
  `);

  run("psql", ["-h", socketDir, "-p", String(port), "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-f", migration], { stdio: "ignore" });

  // Authenticated clients cannot execute the write RPC or mutate snapshots.
  expectRejected(
    `set role authenticated; set request.jwt.claim.role='authenticated'; select public.fn_save_offer_calculation('${ids.owner}','${ids.propertyA}',${json(inputs)},${json(results)},${json(decision)},${json(provenance)},'closr-v1','${requestA}','${hashA}',null);`,
    /permission denied/,
    "authenticated RPC writes are denied",
  );
  expectRejected(
    `set role authenticated; set request.jwt.claim.sub='${ids.owner}'; update public.offer_calculations set formula_version='tampered';`,
    /permission denied/,
    "authenticated table writes are denied",
  );

  psql(`update public.memberships set acquisitions_enabled=false where user_id='${ids.owner}' and org_id='${ids.orgA}';`);
  expectRejected(saveSql({ requestId: requestA, requestHash: hashA }), /FORBIDDEN/, "non-acquisition owner save denied");
  psql(`update public.memberships set acquisitions_enabled=true where user_id='${ids.owner}' and org_id='${ids.orgA}';`);

  const first = JSON.parse(psql(saveSql({ requestId: requestA, requestHash: hashA })));
  expectEqual(first.version, 1, "first calculation version");
  expectEqual(first.property_id, ids.propertyA, "property identity");
  expectEqual(first.worksheet_sha256, worksheetSha256, "worksheet source checksum");
  expectEqual(psql(`select count(*) from public.lead_events where source_type='offer_calculation' and source_id='${first.id}'`), "1", "one calculation event");

  // Same request returns the same full snapshot, while a changed actor or
  // payload cannot claim the idempotency receipt.
  const replay = JSON.parse(psql(saveSql({ requestId: requestA, requestHash: hashA })));
  expectEqual(replay.id, first.id, "idempotent retry identity");
  expectRejected(saveSql({ userId: ids.rep, requestId: requestA, requestHash: hashA }), /IDEMPOTENCY_CONFLICT/, "actor conflict");
  expectRejected(saveSql({ requestId: requestA, requestHash: hashB }), /IDEMPOTENCY_CONFLICT/, "hash conflict");

  const revision = JSON.parse(psql(saveSql({ requestId: requestB, requestHash: hashB, parentId: first.id })));
  expectEqual(revision.series_id, first.series_id, "revision series");
  expectEqual(revision.version, 2, "revision version");
  expectEqual(revision.parent_id, first.id, "revision parent");

  expectRejected(
    saveSql({ userId: ids.rep, propertyId: ids.propertyA2, requestId: requestJ, requestHash: "3".repeat(64) }),
    /STALE_ASSIGNMENT/,
    "non-owner assignment is enforced",
  );
  expectRejected(
    saveSql({ propertyId: ids.propertyA2, requestId: requestK, requestHash: "4".repeat(64), parentId: first.id }),
    /INVALID_PARENT/,
    "parent lead identity is enforced",
  );

  // Property locking allocates distinct versions for concurrent revisions.
  const concurrent = await Promise.all([
    psqlAsync(saveSql({ requestId: requestC, requestHash: hashC, parentId: first.id })),
    psqlAsync(saveSql({ requestId: requestD, requestHash: hashD, parentId: first.id })),
  ]);
  const concurrentVersions = concurrent.map((value) => JSON.parse(value).version).sort((a, b) => a - b);
  expectEqual(JSON.stringify(concurrentVersions), JSON.stringify([3, 4]), "concurrent revision versions");
  expectEqual(psql(`select count(*) from public.offer_calculations where property_id='${ids.propertyA}'`), "4", "concurrent rows");
  expectEqual(psql(`select count(*) from public.lead_events where event_type='calculation_saved' and property_id='${ids.propertyA}'`), "4", "concurrent events");

  // Replay and revision overlap on the same lead. Both paths must complete
  // without a snapshot/property lock inversion; the revision gets the next
  // version under the property row lock and replay returns the original id.
  const replayRevision = await Promise.all([
    psqlAsync(saveSql({ requestId: requestA, requestHash: hashA })),
    psqlAsync(saveSql({ requestId: requestI, requestHash: hashI, parentId: first.id })),
  ]);
  const replayRevisionRows = replayRevision.map((value) => JSON.parse(value));
  expectEqual(replayRevisionRows.some((row) => row.id === first.id), true, "overlapping replay identity");
  expectEqual(replayRevisionRows.some((row) => row.version === 5), true, "overlapping revision version");

  // Force the replay to observe an existing receipt and wait on the property
  // lock before the revision begins. The lock holder can still run a revision
  // because the RPC takes the property lock before it locks the parent. The
  // old snapshot-first retry order deadlocked here (replay held the snapshot
  // while waiting for the property; revision held the property while waiting
  // for the snapshot), so this is a deterministic regression rather than a
  // best-effort Promise.all race.
  const lockClient = await connectPgClient();
  const replayClient = await connectPgClient();
  const activityClient = await connectPgClient();
  let replayPromise;
  try {
    await lockClient.query("set role service_role; set request.jwt.claim.role='service_role'; begin");
    await lockClient.query(`select id from public.properties where id='${ids.propertyA}' for update`);
    const pidResult = await replayClient.query("select pg_backend_pid() as pid");
    const replayPid = pidResult.rows[0].pid;
    await replayClient.query("set role service_role; set request.jwt.claim.role='service_role'");
    replayPromise = replayClient.query(saveRpcSql({ requestId: requestA, requestHash: hashA }));
    await waitForLockWait(activityClient, replayPid, "deterministic replay");

    const deterministicRevision =
      (await lockClient.query(saveRpcSql({ requestId: requestL, requestHash: hashL, parentId: first.id }))).rows[0].fn_save_offer_calculation;
    expectEqual(deterministicRevision.version, 6, "deterministic revision version");
    expectEqual(deterministicRevision.parent_id, first.id, "deterministic revision parent");
    await lockClient.query("commit");

    const replayResult = await replayPromise;
    const replayRow = replayResult.rows[0].fn_save_offer_calculation;
    expectEqual(replayRow.id, first.id, "deterministic replay identity");
  } finally {
    try { await lockClient.query("rollback"); } catch {}
    if (replayPromise) await replayPromise.catch(() => {});
    await Promise.all([lockClient.end(), replayClient.end(), activityClient.end()]);
  }

  // Replaying a prior receipt still requires active access.
  psql(`update public.memberships set access_status='revoked' where user_id='${ids.owner}' and org_id='${ids.orgA}';`);
  expectRejected(saveSql({ requestId: requestA, requestHash: hashA }), /FORBIDDEN/, "revoked replay");
  psql(`update public.memberships set access_status='active' where user_id='${ids.owner}' and org_id='${ids.orgA}';`);
  expectRejected(saveSql({ propertyId: ids.propertyB, requestId: requestE, requestHash: hashE }), /FORBIDDEN/, "cross-org property");

  psql(`update public.properties set status='prospect' where id='${ids.propertyA}';`);
  expectRejected(saveSql({ requestId: requestF, requestHash: "f".repeat(64) }), /NOT_FOUND/, "prospect lead rejected");
  psql(`update public.properties set status='new_lead', deleted_at=now() where id='${ids.propertyA}';`);
  expectRejected(saveSql({ requestId: requestG, requestHash: hashA }), /NOT_FOUND/, "deleted lead rejected");
  expectEqual(psql(`set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${ids.reader}'; select count(*) from public.offer_calculations;`), "0", "deleted lead hidden from read scope");
  psql(`update public.properties set deleted_at=null where id='${ids.propertyA}';`);

  // An event failure aborts both writes in one transaction.
  psql(`
    create or replace function public.reject_calculation_event() returns trigger
      language plpgsql as $$ begin raise exception 'event failure rehearsal'; end $$;
    create trigger reject_calculation_event before insert on public.lead_events
      for each row when (new.event_type='calculation_saved') execute function public.reject_calculation_event();
  `);
  expectRejected(saveSql({ requestId: requestE, requestHash: hashE }), /event failure rehearsal/, "event failure");
  expectEqual(psql(`select count(*) from public.offer_calculations where request_id='${requestE}'`), "0", "snapshot rollback");
  psql("drop trigger reject_calculation_event on public.lead_events; drop function public.reject_calculation_event();");

  // Post-insert changes are immutable, including for the service role.
  expectRejected(
    `set role service_role; set request.jwt.claim.role='service_role'; update public.offer_calculations set formula_version='tampered' where id='${first.id}';`,
    /permission denied|OFFER_CALCULATION_IMMUTABLE/,
    "service table update denied",
  );
  expectRejected(
    `update public.offer_calculations set formula_version='tampered' where id='${first.id}';`,
    /OFFER_CALCULATION_IMMUTABLE/,
    "owner immutable guard",
  );

  // Authenticated read scope: all active same-org members with lead access
  // can read the saved history, including the non-acquisition reader.
  expectEqual(psql(`set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${ids.owner}'; select count(*) from public.offer_calculations;`), "6", "owner read scope");
  expectEqual(psql(`set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${ids.rep}'; select count(*) from public.offer_calculations;`), "6", "assigned rep read scope");
  expectEqual(psql(`set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${ids.reader}'; select count(*) from public.offer_calculations;`), "6", "non-acquisition member lead read scope");

  // The latest merge wrapper repoints calculation rows before deleting the
  // loser, preserving series/version and the event source identity.
  const loserSnapshot = JSON.parse(psql(saveSql({ propertyId: ids.loser, requestId: requestE, requestHash: hashE })));
  psql(`set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${ids.owner}'; select public.merge_duplicate_properties('${ids.keeper}','${ids.loser}');`);
  expectEqual(psql(`select property_id from public.offer_calculations where id='${loserSnapshot.id}'`), ids.keeper, "merge repoints calculation");
  expectEqual(psql(`select version::text from public.offer_calculations where id='${loserSnapshot.id}'`), String(loserSnapshot.version), "merge preserves version");
  expectEqual(psql(`select count(*) from public.properties where id='${ids.loser}'`), "0", "merge removes loser property");

  // A replay racing the merge may finish before the repoint or observe the
  // loser after it has been removed. Either outcome is safe and must not leave
  // a partial snapshot/event write or a blocked transaction.
  const overlapSnapshot = JSON.parse(psql(saveSql({ propertyId: ids.overlapLoser, requestId: requestH, requestHash: hashH })));
  const replayMerge = await Promise.allSettled([
    psqlAsync(saveSql({ propertyId: ids.overlapLoser, requestId: requestH, requestHash: hashH })),
    psqlAsync(`set role authenticated; set request.jwt.claim.role='authenticated'; set request.jwt.claim.sub='${ids.owner}'; select public.merge_duplicate_properties('${ids.overlapKeeper}','${ids.overlapLoser}');`),
  ]);
  if (replayMerge[1].status !== "fulfilled") {
    throw new Error(`overlapping merge failed: ${replayMerge[1].reason}`);
  }
  if (replayMerge[0].status === "rejected" && !/IDEMPOTENCY_CONFLICT|NOT_FOUND/.test(String(replayMerge[0].reason))) {
    throw new Error(`overlapping replay failed unexpectedly: ${replayMerge[0].reason}`);
  }
  expectEqual(psql(`select property_id from public.offer_calculations where id='${overlapSnapshot.id}'`), ids.overlapKeeper, "overlapping merge preserved snapshot");

  console.log("offer calculations rehearsal: PASS (ACLs, idempotency, concurrency, deterministic lock ordering, rollback, immutability, revision lineage, read scope, merge preservation)");
} finally {
  if (started) {
    try { run("pg_ctl", ["-D", cluster, "stop", "-m", "immediate"], { stdio: "ignore" }); } catch {}
  }
  rmSync(cluster, { recursive: true, force: true });
  rmSync(socketDir, { recursive: true, force: true });
}
