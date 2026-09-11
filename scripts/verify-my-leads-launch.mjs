import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import pg from 'pg';

const worktree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = process.env.PG17_BIN ?? '/opt/homebrew/opt/postgresql@17/bin';
const dir = mkdtempSync(path.join(tmpdir(), 'my-leads-foundation-'));
const data = path.join(dir, 'data');
let client;
let client2;
let started = false;
const owner = '10000000-0000-4000-8000-000000000001';
const maria = '10000000-0000-4000-8000-000000000002';
const org = '10000000-0000-4000-8000-000000000003';
const property = '10000000-0000-4000-8000-000000000004';
const legacyProperty = '10000000-0000-4000-8000-000000000049';
const command = '10000000-0000-4000-8000-000000000005';

async function rejectsSql(sql, params, code) {
  await assert.rejects(client.query(sql, params), error => error?.code === code);
}

try {
  assert.match(execFileSync(path.join(bin, 'postgres'), ['--version'], { encoding: 'utf8' }), /PostgreSQL\) 17\./);
  execFileSync(path.join(bin, 'initdb'), ['-D', data, '-A', 'trust', '-U', 'postgres', '--no-locale'], { stdio: 'pipe' });
  execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-l', path.join(dir, 'postgres.log'), '-o', `-k ${dir} -c listen_addresses=''`, '-w', 'start'], { stdio: 'pipe' });
  started = true;
  client = new pg.Client({ host: dir, user: 'postgres', database: 'postgres' });
  await client.connect();
  await client.query(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema extensions;
    create extension pgcrypto;
    create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    create function extensions.gen_random_uuid() returns uuid language sql volatile as $$
      select public.gen_random_uuid()
    $$;
    create function extensions.digest(bytea, text) returns bytea language sql immutable as $$
      select public.digest($1, $2)
    $$;
    create table public.organizations (id uuid primary key);
    create table public.memberships (
      id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null,
      user_id uuid not null, role text not null default 'member', access_status text not null default 'active',
      deletion_prepared_at timestamptz, access_expires_at timestamptz, hugo_config jsonb not null default '{}'::jsonb
    );
    create table public.properties (
      id uuid primary key, org_id uuid not null, assigned_user_id uuid, status text not null default 'new',
      address text not null default '1 Main St', city text, state text, zip text, motivation_level text, outreach_dispo text, updated_at timestamptz not null default now(),
      deleted_at timestamptz, is_dnc_locked boolean not null default false,
      homeowner_contact_id uuid,
      unique (id, org_id)
    );
    create table public.call_activities (
      id uuid primary key, property_id uuid, org_id uuid not null
    );
    create table public.lead_events (
      id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, property_id uuid not null,
      actor_type text not null, actor_id uuid, event_type text not null, payload jsonb not null default '{}'::jsonb,
      source_type text, source_id uuid, created_at timestamptz not null default now()
    );
    create unique index lead_events_source_uidx on public.lead_events(source_type, source_id) where source_id is not null;
    create table public.contacts (
      id uuid primary key, org_id uuid not null, first_name text, last_name text, phone_1 text, phone_2 text, phone_3 text, phone_4 text, do_not_contact boolean not null default false
    );
    create table public.tasks (
      id uuid primary key, org_id uuid not null, related_property_id uuid, type text, status text,
      due_at timestamptz, snoozed_until timestamptz, assignee_id uuid, title text, outcome text
    );
    create table public.lead_notes (
      id uuid primary key, org_id uuid not null, property_id uuid not null, author_user_id uuid,
      body text not null default '', created_at timestamptz not null default now()
    );
    insert into public.organizations values ('${org}');
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${owner}', 'owner@example.test', '{"full_name":"Owner"}'),
      ('${maria}', 'maria@example.test', '{"full_name":"Maria"}');
    insert into public.memberships (org_id, user_id, role) values
      ('${org}', '${owner}', 'owner'), ('${org}', '${maria}', 'member');
  `);
  // This lead predates the My Leads migrations and therefore has no observer
  // created assignment episode. Launch must snapshot that absence and create
  // only its launch episode during apply.
  await client.query(
    'insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)',
    [legacyProperty, org, maria, 'new_lead'],
  );
  for (const name of ['20260912080000_acquisition_time_helpers.sql', '20260912090000_acquisition_settings.sql', '20260912090100_acquisition_queue_episodes.sql', '20260912090200_acquisition_attempt_offer_facts.sql', '20260912100000_acquisition_call_evidence.sql', '20260912110000_acquisition_read_model.sql', '20260912111000_acquisition_kpis.sql', '20260912112000_acquisition_roster.sql', '20260912113000_acquisition_detail.sql', '20260912120000_acquisition_workflow_commands.sql', '20260912140000_acquisition_launch_commands.sql']) {
    await client.query(readFileSync(path.join(worktree, 'supabase/migrations', name), 'utf8'));
  }
  client2 = new pg.Client({ host: dir, user: 'postgres', database: 'postgres' });
  await client2.connect();

  await client.query(`set role authenticated; select set_config('request.jwt.claim.sub', '${owner}', false);`);
  await rejectsSql('select * from public.acquisition_queue_states', [], '42501');
  const designation = await client.query(
    'select public.fn_set_acquisition_designation($1,$2,$3,$4,$5) as result',
    [org, maria, true, false, command],
  );
  assert.equal(designation.rows[0].result.acquisitionsEnabled, true);
  await rejectsSql(
    'select public.fn_set_acquisition_designation($1,$2,$3,$4,$5)',
    [org, maria, false, false, '10000000-0000-4000-8000-000000000006'],
    '40001',
  );
  const replay = await client.query(
    'select public.fn_set_acquisition_designation($1,$2,$3,$4,$5) as result',
    [org, maria, true, false, command],
  );
  assert.equal(replay.rows[0].result.duplicate, true);
  const settings = await client.query(
    'select public.fn_set_acquisition_settings($1,$2,$3,$4) as result',
    [org, owner, 0, '10000000-0000-4000-8000-000000000007'],
  );
  assert.equal(settings.rows[0].result.settingsRevision, 0);
  await rejectsSql(
    'select public.fn_set_acquisition_settings($1,$2,$3,$4)',
    [org, owner, 1, '10000000-0000-4000-8000-000000000008'],
    '40001',
  );
  const ownerRoster = (await client.query(
    'select public.fn_get_acquisition_roster($1) as result', [org],
  )).rows[0].result;
  assert.deepEqual(ownerRoster.settings.recipient, { id: owner, label: 'Owner' });
  assert.equal(ownerRoster.settings.recipientId, owner);
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [maria]);
  const memberRoster = (await client.query(
    'select public.fn_get_acquisition_roster($1) as result', [org],
  )).rows[0].result;
  assert.deepEqual(memberRoster.settings.recipient, { id: owner, label: 'Owner' });
  assert.equal(memberRoster.settings.recipientId, null);
  assert.deepEqual(memberRoster.members.map(member => member.id), [maria]);
  await client.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
  await client.query('reset role');

  // P13 exact preview/apply/replay/rollback rehearsal while the rollout gate
  // is still disabled. The launch creates no attempt or offer.
  const property2 = '10000000-0000-4000-8000-000000000014';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [property, org, maria, 'new_lead']);
  const launchPreview = (await client.query(
    'select public.fn_preview_acquisition_launch($1,$2) as result', [org, maria],
  )).rows[0].result;
  assert.equal(launchPreview.ok, true);
  assert.equal(launchPreview.previewCount, 2);
  assert.deepEqual(
    launchPreview.rows.map(row => row.property_id).sort(),
    [legacyProperty, property].sort(),
  );
  const legacyPreviewRow = launchPreview.rows.find(row => row.property_id === legacyProperty);
  assert.equal(legacyPreviewRow.expected_episode_id, null);
  assert.equal(legacyPreviewRow.expected_episode_initialized_at, null);
  const launchApply = (await client.query(
    'select public.fn_apply_acquisition_launch($1,$2,$3,$4,$5,$6) as result',
    [org, maria, launchPreview.cohortId, launchPreview.fingerprint,
      launchPreview.settingsRevision, '10000000-0000-4000-8000-000000000030'],
  )).rows[0].result;
  assert.deepEqual(
    { ok: launchApply.ok, duplicate: launchApply.duplicate, count: launchApply.count },
    { ok: true, duplicate: false, count: 2 },
  );
  const launchReplay = (await client.query(
    'select public.fn_apply_acquisition_launch($1,$2,$3,$4,$5,$6) as result',
    [org, maria, launchPreview.cohortId, launchPreview.fingerprint,
      launchPreview.settingsRevision, '10000000-0000-4000-8000-000000000030'],
  )).rows[0].result;
  assert.equal(launchReplay.duplicate, true);
  const launchState = (await client.query(`
    select e.episode_kind, e.eligible, q.launch_cohort_id, s.my_leads_enabled
    from public.acquisition_assignment_episodes e
    left join public.acquisition_queue_states q
      on q.org_id=e.org_id and q.property_id=e.property_id
    join public.acquisition_org_settings s on s.org_id=e.org_id
    where e.org_id=$1 and e.property_id=$2 and e.ended_at is null
  `, [org, property])).rows[0];
  assert.deepEqual(launchState, {
    episode_kind: 'launch', eligible: false,
    launch_cohort_id: launchPreview.cohortId, my_leads_enabled: false,
  });
  const launchRollback = (await client.query(
    'select public.fn_rollback_acquisition_launch($1,$2,$3) as result',
    [org, launchPreview.cohortId, '10000000-0000-4000-8000-000000000031'],
  )).rows[0].result;
  assert.deepEqual(
    { ok: launchRollback.ok, duplicate: launchRollback.duplicate, count: launchRollback.count },
    { ok: true, duplicate: false, count: 2 },
  );
  const launchRestored = (await client.query(`
    select e.episode_kind, e.eligible, q.property_id
    from public.acquisition_assignment_episodes e
    left join public.acquisition_queue_states q
      on q.org_id=e.org_id and q.property_id=e.property_id
    where e.org_id=$1 and e.property_id=$2 and e.ended_at is null
  `, [org, property])).rows[0];
  assert.deepEqual(launchRestored, { episode_kind: 'live', eligible: false, property_id: null });
  const legacyRestored = await client.query(`
    select count(*)::int as open_episodes,
           (select count(*)::int from public.acquisition_queue_states q
            where q.org_id=$1 and q.property_id=$2) as queue_rows
    from public.acquisition_assignment_episodes e
    where e.org_id=$1 and e.property_id=$2 and e.ended_at is null
  `, [org, legacyProperty]);
  assert.deepEqual(legacyRestored.rows[0], { open_episodes: 0, queue_rows: 0 });

  const staleProperty = '10000000-0000-4000-8000-000000000032';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [staleProperty, org, maria, 'new_lead']);
  const stalePreview = (await client.query(
    'select public.fn_preview_acquisition_launch($1,$2) as result', [org, maria],
  )).rows[0].result;
  await client.query('update public.properties set assigned_user_id=$1 where id=$2', [owner, staleProperty]);
  await client.query('update public.properties set assigned_user_id=$1 where id=$2', [maria, staleProperty]);
  await rejectsSql(
    'select public.fn_apply_acquisition_launch($1,$2,$3,$4,$5,$6)',
    [org, maria, stalePreview.cohortId, stalePreview.fingerprint,
      stalePreview.settingsRevision, '10000000-0000-0000-0000-000000000033'],
    '40001',
  );

  const designationProperty = '10000000-0000-4000-8000-000000000034';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [designationProperty, org, maria, 'new_lead']);
  const designationPreview = (await client.query(
    'select public.fn_preview_acquisition_launch($1,$2) as result', [org, maria],
  )).rows[0].result;
  await client.query('set role authenticated');
  await client.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', owner]);
  await client.query(
    'select public.fn_set_acquisition_designation($1,$2,$3,$4,$5)',
    [org, maria, false, true, '10000000-0000-4000-8000-000000000035'],
  );
  await rejectsSql(
    'select public.fn_apply_acquisition_launch($1,$2,$3,$4,$5,$6)',
    [org, maria, designationPreview.cohortId, designationPreview.fingerprint,
      designationPreview.settingsRevision, '10000000-0000-4000-8000-000000000036'],
    '40001',
  );
  await client.query(
    'select public.fn_set_acquisition_designation($1,$2,$3,$4,$5)',
    [org, maria, true, false, '10000000-0000-4000-8000-000000000037'],
  );
  await client.query('reset role');

  const blockedProperty = '10000000-0000-4000-8000-000000000038';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [blockedProperty, org, maria, 'new_lead']);
  const blockedPreview = (await client.query(
    'select public.fn_preview_acquisition_launch($1,$2) as result', [org, maria],
  )).rows[0].result;
  const blockedApply = (await client.query(
    'select public.fn_apply_acquisition_launch($1,$2,$3,$4,$5,$6) as result',
    [org, maria, blockedPreview.cohortId, blockedPreview.fingerprint,
      blockedPreview.settingsRevision, '10000000-0000-4000-8000-000000000039'],
  )).rows[0].result;
  const blockedEpisode = (await client.query(
    'select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null',
    [org, blockedProperty],
  )).rows[0].id;
  await client.query(
    `insert into public.acquisition_attempts
      (org_id, property_id, actor_user_id, assignment_episode_id, attempt_kind, source, outcome, occurred_at, idempotency_key)
     values ($1,$2,$3,$4,'outreach','manual','reached',now(),$5)`,
    [org, blockedProperty, maria, blockedEpisode, '10000000-0000-4000-8000-000000000040'],
  );
  await rejectsSql(
    'select public.fn_rollback_acquisition_launch($1,$2,$3)',
    [org, blockedApply.cohortId, '10000000-0000-4000-8000-000000000041'],
    '40001',
  );

  await client.query('update public.acquisition_org_settings set my_leads_enabled=true where org_id=$1', [org]);
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [property2, org, maria, 'new_lead']);
  const episode2 = await client.query('select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null', [org, property2]);
  const episode2Id = episode2.rows[0].id;
  await client.query('set role service_role');
  const tokenHash = 'a'.repeat(64);
  const binding = await client.query('select public.fn_bind_acquisition_call_context($1,$2,$3,$4) as result', [org, property2, maria, tokenHash]);
  assert.equal(binding.rows[0].result.tracked, true);
  const callStart = await client.query(`select public.fn_record_acquisition_call_start($1::jsonb) as result`, [JSON.stringify({
    eventVersion: 1, evidence: 'seller_call_create_succeeded', orgId: org, propertyId: property2,
    actorUserId: maria, assignmentEpisodeId: episode2Id, tokenHash, jitterCallId: 'jitter-1',
    sellerProviderCallId: 'seller-1', occurredAt: new Date().toISOString()
  })]);
  assert.equal(callStart.rows[0].result.attemptId !== undefined, true);
  await client.query('reset role');
  await client.query(`set role authenticated; select set_config('request.jwt.claim.sub', '${owner}', false);`);
  const page = await client.query('select public.fn_get_acquisition_queue_page($1,$2) as result', [org, maria]);
  assert.equal(page.rows[0].result.stages.contacted.rows.some(row => row.propertyId === property2), true);
  await client.query('reset role');

  await rejectsSql(
    `insert into public.memberships (org_id, user_id, acquisitions_enabled) values ($1,$2,true)`,
    [org, owner],
    '42501',
  );
  await rejectsSql(
    `update public.memberships set acquisitions_enabled = false where org_id=$1 and user_id=$2`,
    [org, maria],
    '42501',
  );
  const episode = await client.query('select eligible, assignee_user_id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null', [org, property]);
  assert.deepEqual(episode.rows, [{ eligible: false, assignee_user_id: maria }]);
  await rejectsSql(`insert into public.acquisition_queue_states (property_id, org_id, stage, stage_entered_at, motivation_recorded, motivation_recorded_at, motivation_recorded_by) values ($1,$2,'contacted',now(),true,now(),$3)`, [property, org, owner], '23514');
  await rejectsSql(`insert into public.acquisition_attempts (org_id, property_id, actor_user_id, attempt_kind, source, occurred_at, idempotency_key) values ($1,$2,$3,'call','dialpad',now(),$4)`, [org, property, maria, '10000000-0000-4000-8000-000000000009'], '23514');
  await client.query(`insert into public.acquisition_attempts (org_id, property_id, actor_user_id, attempt_kind, source, outcome, occurred_at, idempotency_key) values ($1,$2,$3,'call','dialpad','no_answer',now(),$4)`, [org, property, maria, '10000000-0000-4000-8000-000000000010']);
  await rejectsSql(`insert into public.acquisition_offers (org_id, property_id, actor_user_id, amount_cents, sent_via, sent_at, follow_up_at, idempotency_key) values ($1,$2,$3,0,'verbal',now(),now()+interval '1 hour',$4)`, [org, property, maria, '10000000-0000-4000-8000-000000000011'], '23514');
  await client.query(`insert into public.acquisition_offers (org_id, property_id, actor_user_id, amount_cents, sent_via, sent_at, follow_up_at, idempotency_key) values ($1,$2,$3,1000,'verbal',now(),now()+interval '1 hour',$4)`, [org, property, maria, '10000000-0000-4000-8000-000000000012']);
  await rejectsSql(`insert into public.acquisition_offers (org_id, property_id, actor_user_id, amount_cents, sent_via, sent_at, follow_up_at, idempotency_key) values ($1,$2,$3,2000,'verbal',now(),now()+interval '2 hour',$4)`, [org, property, maria, '10000000-0000-4000-8000-000000000013'], '23505');
  const workflowInput = async (fn, payload) => {
    const result = await client.query(`select public.${fn}($1::jsonb) as result`, [JSON.stringify(payload)]);
    return result.rows[0].result;
  };
  const directContractProperty = '10000000-0000-4000-8000-000000000047';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [directContractProperty, org, maria, 'contacted']);
  const directContractEpisode = (await client.query(
    'select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null',
    [org, directContractProperty],
  )).rows[0].id;
  const directContract = await workflowInput('fn_record_acquisition_contract', {
    orgId: org, propertyId: directContractProperty, expectedEpisodeId: directContractEpisode,
    expectedQueueVersion: 0, expectedSharedStatus: 'contacted',
    idempotencyKey: '10000000-0000-4000-8000-000000000048',
    signedAt: new Date(Date.now() - 1000).toISOString(), offerId: null,
  });
  assert.deepEqual(
    { stage: directContract.stage, queueVersion: directContract.queueVersion },
    { stage: 'under_contract', queueVersion: 1 },
  );
  await rejectsSql(
    'select public.fn_record_acquisition_contract($1::jsonb)',
    [JSON.stringify({
      orgId: org, propertyId: directContractProperty, expectedEpisodeId: directContractEpisode,
      expectedQueueVersion: 1, expectedSharedStatus: 'under_contract',
      idempotencyKey: '10000000-0000-4000-8000-000000000049', signedAt: 'infinity', offerId: null,
    })],
    '22023',
  );
  const dncProperty = '10000000-0000-4000-8000-000000000057';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [dncProperty, org, maria, 'new_lead']);
  await client.query('update public.properties set is_dnc_locked=true where id=$1', [dncProperty]);
  await client.query(`set role authenticated; select set_config('request.jwt.claim.sub', '${owner}', false);`);
  await rejectsSql(
    'select public.fn_get_acquisition_detail($1,$2,$3,$4,$5)',
    [org, maria, dncProperty, 'notes', null],
    '42501',
  );
  await client.query('reset role');
  for (const [key, sentAt, followUpAt] of [
    ['10000000-0000-4000-8000-000000000050', 'infinity', 'infinity'],
    ['10000000-0000-4000-8000-000000000051', '2999-01-01T00:00:00Z', '2999-01-02T00:00:00Z'],
    ['10000000-0000-4000-8000-000000000052', '2026-09-11T14:00:00Z', 'infinity'],
  ]) {
    await rejectsSql(
      'select public.fn_log_acquisition_offer($1::jsonb)',
      [JSON.stringify({
        orgId: org, propertyId: directContractProperty, expectedEpisodeId: directContractEpisode,
        expectedQueueVersion: 1, expectedSharedStatus: 'under_contract', idempotencyKey: key,
        amountCents: 1000, method: 'verbal', sentAt, followUpAt,
        motivationResponse: { kind: 'no_motivation', text: null }, temperature: null,
      })],
      '22023',
    );
  }
  for (const [key, occurredAt] of [
    ['10000000-0000-4000-8000-000000000053', 'infinity'],
    ['10000000-0000-4000-8000-000000000054', '2999-01-01T00:00:00Z'],
  ]) {
    await rejectsSql(
      'select public.fn_decline_acquisition_offer($1::jsonb)',
      [JSON.stringify({
        orgId: org, propertyId: directContractProperty, expectedEpisodeId: directContractEpisode,
        expectedQueueVersion: 1, expectedSharedStatus: 'under_contract', idempotencyKey: key,
        pendingOfferId: '10000000-0000-4000-8000-000000000055', occurredAt,
      })],
      '22023',
    );
  }
  const state1 = await client.query('select p.status, q.version, q.stage from public.properties p left join public.acquisition_queue_states q on q.org_id=p.org_id and q.property_id=p.id where p.id=$1', [property2]);
  const readyResult = await workflowInput('fn_ready_acquisition_offer', {
    orgId: org, propertyId: property2, expectedEpisodeId: episode2Id,
    expectedQueueVersion: state1.rows[0].version, expectedSharedStatus: state1.rows[0].status,
    idempotencyKey: '10000000-0000-4000-8000-000000000020',
    motivationResponse: { kind: 'specified', text: 'Moving soon' }, temperature: 'warm'
  });
  assert.equal(readyResult.stage, 'needs_offer');
  const readyReplay = await workflowInput('fn_ready_acquisition_offer', {
    orgId: org, propertyId: property2, expectedEpisodeId: episode2Id,
    expectedQueueVersion: state1.rows[0].version, expectedSharedStatus: state1.rows[0].status,
    idempotencyKey: '10000000-0000-4000-8000-000000000020',
    motivationResponse: { kind: 'specified', text: 'Moving soon' }, temperature: 'warm'
  });
  assert.equal(readyReplay.duplicate, true);
  const offerResult = await workflowInput('fn_log_acquisition_offer', {
    orgId: org, propertyId: property2, expectedEpisodeId: episode2Id,
    expectedQueueVersion: readyResult.queueVersion, expectedSharedStatus: 'interested',
    idempotencyKey: '10000000-0000-4000-8000-000000000021', amountCents: 125000,
    method: 'verbal', sentAt: '2026-09-11T14:00:00Z', followUpAt: '2026-09-12T14:00:00Z',
    motivationResponse: null, temperature: null
  });
  assert.equal(offerResult.stage, 'offer_sent');
  const contractResult = await workflowInput('fn_record_acquisition_contract', {
    orgId: org, propertyId: property2, expectedEpisodeId: episode2Id,
    expectedQueueVersion: offerResult.queueVersion, expectedSharedStatus: 'offer_sent',
    idempotencyKey: '10000000-0000-4000-8000-000000000022', signedAt: new Date(Date.now() - 1000).toISOString(), offerId: offerResult.offerId
  });
  assert.equal(contractResult.stage, 'under_contract');
  const archiveResult = await workflowInput('fn_archive_acquisition_contract', {
    orgId: org, propertyId: property2, expectedEpisodeId: episode2Id,
    expectedQueueVersion: contractResult.queueVersion, expectedSharedStatus: 'under_contract',
    idempotencyKey: '10000000-0000-4000-8000-000000000023'
  });
  assert.equal(archiveResult.archived, true);
  const property3 = '10000000-0000-4000-8000-000000000024';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [property3, org, maria, 'new_lead']);
  const episode3 = (await client.query('select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null', [org, property3])).rows[0].id;
  const offer3 = await workflowInput('fn_log_acquisition_offer', {
    orgId: org, propertyId: property3, expectedEpisodeId: episode3, expectedQueueVersion: 0,
    expectedSharedStatus: 'new_lead', idempotencyKey: '10000000-0000-4000-8000-000000000025', amountCents: 1000,
    method: 'verbal', sentAt: '2026-09-11T14:00:00Z', followUpAt: '2026-09-12T14:00:00Z',
    motivationResponse: { kind: 'no_motivation', text: null }, temperature: null
  });
  const decline3 = await workflowInput('fn_decline_acquisition_offer', {
    orgId: org, propertyId: property3, expectedEpisodeId: episode3, expectedQueueVersion: offer3.queueVersion,
    expectedSharedStatus: 'offer_sent', idempotencyKey: '10000000-0000-4000-8000-000000000026', pendingOfferId: offer3.offerId,
    occurredAt: '2026-09-10T14:00:00Z'
  });
  assert.equal(decline3.archived, true);
  const afterDecline = await client.query('select p.assigned_user_id, p.outreach_dispo, q.archive_reason from public.properties p join public.acquisition_queue_states q on q.org_id=p.org_id and q.property_id=p.id where p.id=$1', [property3]);
  assert.deepEqual(afterDecline.rows[0], { assigned_user_id: owner, outreach_dispo: 'needs_sequence', archive_reason: 'needs_sequence_handoff' });
  const property4 = '10000000-0000-4000-8000-000000000027';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [property4, org, maria, 'contacted']);
  const episode4 = (await client.query('select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null', [org, property4])).rows[0].id;
  const handoff4 = await workflowInput('fn_handoff_acquisition_lead', {
    orgId: org, propertyId: property4, expectedEpisodeId: episode4, expectedQueueVersion: 0,
    expectedSharedStatus: 'contacted', idempotencyKey: '10000000-0000-4000-8000-000000000028',
    reason: 'needs_nurture', recipientUserId: owner
  });
  assert.equal(handoff4.archived, true);

  const concurrentProperty = '10000000-0000-4000-8000-000000000042';
  await client.query('reset role');
  await client2.query('reset role');
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [concurrentProperty, org, maria, 'new_lead']);
  const concurrentEpisode = (await client.query(
    'select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null',
    [org, concurrentProperty],
  )).rows[0].id;
  await client.query('set role authenticated');
  await client2.query('set role authenticated');
  await client.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', maria]);
  await client2.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', maria]);
  const concurrentPayload = requestId => JSON.stringify({
    orgId: org, propertyId: concurrentProperty, expectedEpisodeId: concurrentEpisode,
    expectedQueueVersion: 0, expectedSharedStatus: 'new_lead', idempotencyKey: requestId,
    amountCents: 1000, method: 'verbal', sentAt: '2026-09-11T14:00:00Z',
    followUpAt: '2026-09-12T14:00:00Z', motivationResponse: { kind: 'no_motivation', text: null },
    temperature: null,
  });
  const concurrentResults = await Promise.allSettled([
    client.query('select public.fn_log_acquisition_offer($1::jsonb) as result', [concurrentPayload('10000000-0000-4000-8000-000000000043')]),
    client2.query('select public.fn_log_acquisition_offer($1::jsonb) as result', [concurrentPayload('10000000-0000-4000-8000-000000000044')]),
  ]);
  assert.equal(concurrentResults.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrentResults.filter(result => result.status === 'rejected' && result.reason?.code === '40001').length, 1);
  await client.query('reset role');
  await client2.query('reset role');

  const staleHandoffProperty = '10000000-0000-4000-8000-000000000045';
  await client.query('insert into public.properties (id, org_id, assigned_user_id, status) values ($1,$2,$3,$4)', [staleHandoffProperty, org, maria, 'contacted']);
  const staleHandoffEpisode = (await client.query(
    'select id from public.acquisition_assignment_episodes where org_id=$1 and property_id=$2 and ended_at is null',
    [org, staleHandoffProperty],
  )).rows[0].id;
  await client.query('update public.properties set assigned_user_id=$1 where org_id=$2 and id=$3', [owner, org, staleHandoffProperty]);
  await client.query('set role authenticated');
  await client.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', maria]);
  await rejectsSql(
    'select public.fn_handoff_acquisition_lead($1::jsonb)',
    [JSON.stringify({
      orgId: org, propertyId: staleHandoffProperty, expectedEpisodeId: staleHandoffEpisode,
      expectedQueueVersion: 0, expectedSharedStatus: 'contacted',
      idempotencyKey: '10000000-0000-4000-8000-000000000046', reason: 'needs_nurture', recipientUserId: owner,
    })],
    '40001',
  );
  console.log('PASS: PG17 P01-P03 + P05/P06/P13 RPC wrappers, CAS workflow transitions, concurrent offer CAS, stale handoff, launch apply/replay/rollback, stale assignment/designation invalidation, and activity-blocked rollback');
} finally {
  await client2?.end();
  await client?.end();
  if (started) execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
  rmSync(dir, { recursive: true, force: true });
}
