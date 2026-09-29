import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

export function parseArgs(args) {
  const result = { apiPort: 55421, dbPort: 55422, excludeMigrations: [], baselineOwner: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--api-port' || arg === '--db-port' || arg === '--exclude-migrations') {
      const value = args[++i];
      if (!value) throw new Error(`Missing ${arg} value`);
      if (arg === '--exclude-migrations') result.excludeMigrations.push(value);
      else {
        if (!/^\d+$/.test(value) || +value < 1024 || +value > 65535) throw new Error(`Invalid ${arg}`);
        result[arg === '--api-port' ? 'apiPort' : 'dbPort'] = +value;
      }
    } else if (arg === '--no-baseline-owner') result.baselineOwner = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.apiPort === result.dbPort || [54321, 54322].includes(result.apiPort) || [54321, 54322].includes(result.dbPort)) throw new Error('Ports must be distinct and leave 54321/54322 to the fault proxy');
  return result;
}
export function excluded(file, patterns) {
  return patterns.some(pattern => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`).test(file));
}
function publish(name, value) {
  if (!process.env.GITHUB_ENV || /[\r\n]/.test(value)) throw new Error('Invalid runner environment');
  appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}
export async function main(args = process.argv.slice(2)) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV) throw new Error('GitHub runner required');
  if (Object.entries(process.env).some(([key, value]) => /^(SUPABASE_ACCESS_TOKEN|SUPABASE_DB_PASSWORD|PROD_.*SUPABASE|TEST_.*SUPABASE_URL)$/.test(key) || /ncsngxlcyxylaeskiteu|copflsklaefwzipsrjqz/.test(value ?? ''))) throw new Error('Hosted Supabase credentials/URLs are forbidden');
  const options = parseArgs(args);
  const workdir = mkdtempSync(path.join(process.env.RUNNER_TEMP, 'sandra-heavy-'));
  publish('E2E_LOCAL_WORKDIR', workdir);
  const run = (...argv) => execFileSync('supabase', argv, { stdio: ['ignore', 'pipe', 'inherit'] });
  run('init', '--workdir', workdir);
  const source = readFileSync('supabase/config.toml', 'utf8');
  if (!/^major_version\s*=\s*17\s*$/m.test(source)) throw new Error('Repo config must pin Postgres 17');
  const config = source.replace(/^project_id\s*=.*$/m, `project_id = "sandra-heavy-${randomUUID().slice(0, 8)}"`).replace(/(\[api\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${options.apiPort}`).replace(/(\[db\][\s\S]*?^port\s*=\s*)\d+/m, (_, prefix) => `${prefix}${options.dbPort}`);
  writeFileSync(path.join(workdir, 'supabase/config.toml'), config);
  mkdirSync(path.join(workdir, 'supabase/migrations'), { recursive: true });
  const files = readdirSync('supabase/migrations').filter(file => file.endsWith('.sql') && !excluded(file, options.excludeMigrations));
  for (const file of files) cpSync(path.join('supabase/migrations', file), path.join(workdir, 'supabase/migrations', file));
  try { run('start', '--workdir', workdir); }
  catch { try { run('stop', '--workdir', workdir, '--no-backup'); } catch {} run('start', '--workdir', workdir); }
  const status = JSON.parse(run('status', '--workdir', workdir, '--output', 'json').toString());
  if (status.API_URL !== `http://127.0.0.1:${options.apiPort}` || status.DB_URL !== `postgresql://postgres:postgres@127.0.0.1:${options.dbPort}/postgres`) throw new Error('Unexpected stack endpoints');
  const client = new pg.Client({ connectionString: status.DB_URL });
  await client.connect();
  let version;
  try { version = (await client.query('SHOW server_version_num')).rows[0].server_version_num; } finally { await client.end(); }
  if (!String(version).startsWith('17')) throw new Error(`Expected Postgres 17, got ${version}`);
  for (const key of ['ANON_KEY', 'SERVICE_ROLE_KEY']) {
    if (typeof status[key] !== 'string' || !status[key] || /[\r\n]/.test(status[key])) throw new Error(`Invalid ${key}`);
    console.log(`::add-mask::${status[key]}`);
  }
  if (options.baselineOwner) {
    const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.admin.createUser({ email: `e2e-baseline-${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID(), email_confirm: true, app_metadata: { purpose: 'disposable-e2e-baseline' } });
    if (error || !data.user) throw new Error('Baseline owner creation failed');
    const { error: membershipError } = await admin.from('memberships').upsert({ user_id: data.user.id, org_id: '00000000-0000-0000-0000-000000000bbb', role: 'owner' }, { onConflict: 'user_id,org_id' });
    if (membershipError) throw new Error('Baseline owner membership failed');
  }
  publish('E2E_DISPOSABLE_DATABASE', '1');
  publish('TEST_SUPABASE_URL', status.API_URL);
  publish('TEST_SUPABASE_ANON_KEY', status.ANON_KEY);
  publish('TEST_SUPABASE_SERVICE_ROLE_KEY', status.SERVICE_ROLE_KEY);
  publish('E2E_CI_SUPABASE_DB_URL', status.DB_URL);
  publish('HEAVY_UPSTREAM_API_URL', status.API_URL);
  publish('HEAVY_UPSTREAM_DB_URL', status.DB_URL);
}
if (process.argv[1]?.endsWith('provision-disposable-stack.mjs')) main().catch(error => { console.error(error); process.exitCode = 1; });
