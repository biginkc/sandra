// Local-only SQL proof: real migration, disposable database, exact CAS fences.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
const url = new URL(process.env.SUPABASE_LOCAL_DB_URL ?? 'postgresql://jarradhenry@localhost:5432/postgres');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'local database required');
const admin = new pg.Client({ connectionString: url.href });
await admin.connect();
const name = `skiptrace_claim_${randomUUID().replaceAll('-', '')}`;
await admin.query(`CREATE DATABASE ${name}`);
url.pathname = `/${name}`;
const db = new pg.Client({ connectionString: url.href });
try {
  await db.connect();
  await db.query(`CREATE TABLE public.jobs (
    id uuid PRIMARY KEY, org_id uuid, type text, status text, total_items integer,
    input_params jsonb, provider_run_id text, worker_heartbeat_at timestamptz,
    started_at timestamptz, title text, description text
  )`);
  const migration = readFileSync(new URL('../supabase/migrations/20260909140000_skip_trace_submission_claim.sql', import.meta.url), 'utf8');
  await db.query(migration);
  await db.query(migration);
  const id = randomUUID(), org = randomUUID();
  const ids = Array.from({ length: 3206 }, randomUUID);
  const heartbeat = '2026-09-09T14:00:00.000Z';
  const input = { property_ids: ids, submission_attempt_token: randomUUID() };
  const seed = async (overrides = {}) => {
    await db.query('TRUNCATE jobs');
    const row = { id, org_id: org, type: 'skip_trace', status: 'queued', total_items: ids.length, input_params: { property_ids: ids }, provider_run_id: null, worker_heartbeat_at: heartbeat, ...overrides };
    await db.query(`INSERT INTO jobs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row));
  };
  const claim = (hb = heartbeat) => db.query('SELECT * FROM claim_skip_trace_submission($1,$2,$3,$4,$5,$6)', [id, org, ids, input, heartbeat, hb]);
  await seed();
  assert.equal((await claim()).rowCount, 1);
  assert.equal((await db.query('SELECT input_params FROM jobs')).rows[0].input_params.submission_attempt_token, input.submission_attempt_token);
  assert.equal((await claim()).rowCount, 0, 'replay must lose');
  for (const mismatch of [
    { id: randomUUID() }, { org_id: randomUUID() }, { type: 'cass' },
    { status: 'running' }, { total_items: 3205 },
    { input_params: { property_ids: ids.slice(1) } },
    { provider_run_id: 'already-paid' }, { worker_heartbeat_at: null },
    { worker_heartbeat_at: '2026-09-09T14:01:00.000Z' },
  ]) {
    await seed(mismatch);
    assert.equal((await claim()).rowCount, 0, JSON.stringify(mismatch).slice(0, 100));
  }
  await seed({ worker_heartbeat_at: null });
  assert.equal((await claim(null)).rowCount, 1, 'null heartbeat matches null');
  await seed();
  const competitor = new pg.Client({ connectionString: url.href });
  await competitor.connect();
  try {
    const outcomes = await Promise.all([
      claim(),
      competitor.query('SELECT * FROM claim_skip_trace_submission($1,$2,$3,$4,$5,$6)', [id, org, ids, input, heartbeat, heartbeat]),
    ]);
    assert.equal(outcomes.reduce((n, r) => n + r.rowCount, 0), 1);
  } finally {
    await competitor.end();
  }
  const grants = await db.query(`SELECT has_function_privilege('anon', 'public.claim_skip_trace_submission(uuid,uuid,text[],jsonb,timestamptz,timestamptz)', 'execute') AS anon,
    has_function_privilege('authenticated', 'public.claim_skip_trace_submission(uuid,uuid,text[],jsonb,timestamptz,timestamptz)', 'execute') AS authenticated,
    has_function_privilege('service_role', 'public.claim_skip_trace_submission(uuid,uuid,text[],jsonb,timestamptz,timestamptz)', 'execute') AS service`);
  assert.deepEqual(grants.rows[0], { anon: false, authenticated: false, service: true });
  console.log('PASS: 3,206-ID claim/token, replay, all 9 CAS mismatch fences, null heartbeat, one winner, RPC permissions, migration replay');
} finally {
  await db.end();
  await admin.query(`DROP DATABASE ${name}`);
  await admin.end();
}
