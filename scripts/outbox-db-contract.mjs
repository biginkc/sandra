import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { assertWriteMode } from './outbox-db-contract/guards.mjs';
import { makeRest } from './outbox-db-contract/postgrest.mjs';
import { createFixture } from './outbox-db-contract/fixture.mjs';
import { runContracts } from './outbox-db-contract/contracts.mjs';
import { checkPrivileges } from './outbox-db-contract/privileges.mjs';
import { writeManifest, runPath, sha256 } from './outbox-run-record.mjs';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const MIGRATIONS = ['20260929000000', '20260929000100', '20260929000200'];
const C_IDS = ['C00','C01','C02','C03','C04','C05','C06','C07','C08','C08b','C09','D01','D02','D03','D04','D05'];

function options(args) {
  const value = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--target', '--phase', '--expect-fail'].includes(args[i])) throw new Error(`Unknown option ${args[i]}`);
    value[args[i].slice(2)] = args[++i];
  }
  if (value.target !== 'disposable' || !['pre', 'post'].includes(value.phase)) throw new Error('Disposable write lane requires --target disposable --phase pre|post');
  return value;
}

export async function run(args = process.argv.slice(2), env = process.env) {
  const opts = options(args);
  const apiUrl = env.TEST_SUPABASE_URL;
  const dbUrl = env.E2E_CI_SUPABASE_DB_URL;
  const binding = assertWriteMode(opts.target, { apiUrl, dbUrl, env });
  if (!env.TEST_SUPABASE_ANON_KEY || !env.TEST_SUPABASE_SERVICE_ROLE_KEY) throw new Error('Disposable keys missing');
  if (env.MESSAGING_PROVIDER !== 'mock') throw new Error('Mock provider required');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  if (env.HEAVY_TESTED_SHA && env.HEAVY_TESTED_SHA !== sha) throw new Error('Tested SHA mismatch');
  const runId = env.GITHUB_ACTIONS === 'true' ? `${env.GITHUB_RUN_ID}-${opts.phase}` : `${Date.now()}-${randomUUID().slice(0, 8)}-${opts.phase}`;
  const relative = runPath(sha, 'pre-merge', runId);
  const runDir = path.join(repo, relative);
  mkdirSync(runDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const db = new pg.Client({ connectionString: dbUrl });
  const checks = [];
  let schemaState = {}, verdict = 'FAIL', errorText = '', status = 1;
  try {
    await db.connect();
    const { rows } = await db.query('select version from supabase_migrations.schema_migrations where version=any($1::text[]) order by version', [MIGRATIONS]);
    const versions = rows.map(row => row.version);
    const head = (await db.query("select to_regclass('public.inbox_inbound_heads') is not null as installed")).rows[0].installed;
    schemaState = { versions, inboundHeadsPresent: head };
    if (opts.phase === 'pre' && (versions.length || head)) throw new Error('SCHEMA_PHASE_MISMATCH pre');
    if (opts.phase === 'post' && (versions.length !== 3 || !head)) throw new Error('SCHEMA_PHASE_MISMATCH post');
    const rest = makeRest(apiUrl, env.TEST_SUPABASE_ANON_KEY, env.TEST_SUPABASE_SERVICE_ROLE_KEY);
    const fixture = await createFixture({ apiUrl, serviceKey: env.TEST_SUPABASE_SERVICE_ROLE_KEY, anonKey: env.TEST_SUPABASE_ANON_KEY, rest, runDir });
    checks.push(...await checkPrivileges(db, opts.phase));
    checks.push(...await runContracts({ fixture, db, phase: opts.phase, provider: env.MESSAGING_PROVIDER }));
    const got = new Set(checks.filter(check => check.verdict === 'FAIL').map(check => check.id));
    if (C_IDS.some(id => !checks.some(check => check.id === id))) throw new Error('INCOMPLETE_CONTRACT_SET');
    if (opts['expect-fail']) {
      const expected = new Set(opts['expect-fail'].split(',').filter(Boolean));
      if (got.size !== expected.size || [...got].some(id => !expected.has(id))) throw new Error(`MUTATION_MISMATCH expected=${[...expected].join(',')} got=${[...got].join(',')}`);
      verdict = 'FAIL'; status = 1;
    } else if (got.size) throw new Error(`CONTRACT_FAILURE ${[...got].join(',')}`);
    else { verdict = 'PASS'; status = 0; }
  } catch (error) { errorText = String(error.stack ?? error); }
  finally { await db.end().catch(() => {}); }
  writeFileSync(path.join(runDir, 'contracts.json'), `${JSON.stringify(checks, null, 2)}\n`);
  if (errorText) writeFileSync(path.join(runDir, 'failure.log'), `${errorText}\n`);
  const lane = env.HEAVY_LANE || 'db-contract';
  writeManifest(repo, relative, {
    tested_sha: sha, tier: 'pre-merge', kind: 'db-contract', phase: opts.phase, target: 'disposable', verdict, exit_status: status,
    run_id: runId, started_at: startedAt, completed_at: new Date().toISOString(), target_binding: binding, schema_state: schemaState,
    workflow_path: env.GITHUB_WORKFLOW_REF?.split('@')[0]?.replace(/^[^/]+\/[^/]+\//, '') ?? '', workflow_input_sha: env.HEAVY_TESTED_SHA ?? '',
    github_run_id: env.GITHUB_RUN_ID ?? '', github_run_attempt: env.GITHUB_RUN_ATTEMPT ?? '',
    artifact_name: env.GITHUB_ACTIONS === 'true' ? `heavy-${lane}-${sha}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}` : '',
    event: env.GITHUB_EVENT_NAME ?? '', head_branch: env.GITHUB_REF_NAME ?? '', lane,
    runner_script_sha256: sha256(readFileSync(path.join(repo, 'scripts/inbox-ci', `${lane}.sh`))),
    contracts: checks, failure: errorText ? errorText.split('\n')[0] : null,
  }, env);
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run().then(status => { process.exitCode = status; }).catch(error => { console.error(error); process.exitCode = 1; });
