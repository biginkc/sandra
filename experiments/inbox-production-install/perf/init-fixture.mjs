import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';

const { PERF_DATABASE_URL: dbUrl, PERF_API_URL: apiUrl, PERF_SERVICE_ROLE_KEY: serviceKey, PERF_RUN_DIR: dir, PERF_STACK_ID: stackId } = process.env;
const db = new pg.Client({ connectionString: dbUrl });
const parsed = new URL(dbUrl);
if (process.env.E2E_DISPOSABLE_DATABASE !== '1' || !['127.0.0.1', 'localhost'].includes(parsed.hostname) || parsed.username !== 'postgres' || !stackId?.startsWith('sandra-heavy-perf-')) throw Error('Refusing non-disposable fixture');
if (!['127.0.0.1', 'localhost'].includes(new URL(apiUrl).hostname)) throw Error('Refusing non-local Auth');
await db.connect();
try {
  await db.query('CREATE SCHEMA IF NOT EXISTS install_fixture');
  await db.query('CREATE TABLE install_fixture.perf_identity(marker text PRIMARY KEY)');
  await db.query('INSERT INTO install_fixture.perf_identity(marker) VALUES($1)', [stackId]);
  const org = randomUUID();
  await db.query('INSERT INTO public.organizations(id,name) VALUES($1,$2)', [org, `Perf ${stackId}`]);
  const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.createUser({ email: `perf-${randomUUID()}@example.invalid`, password: randomUUID() + randomUUID(), email_confirm: true });
  if (error || !data?.user?.id) throw Error('Local synthetic Auth user creation failed');
  writeFileSync(`${dir}/identity.json`, JSON.stringify({ org, actor: data.user.id }) + '\n');
} finally {
  await db.end();
}
