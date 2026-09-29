import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { assertWriteMode } from './guards.mjs';

const dbUrl = process.env.E2E_CI_SUPABASE_DB_URL;
assertWriteMode('disposable', { apiUrl: process.env.TEST_SUPABASE_URL, dbUrl, env: process.env });
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  const names = ['messages', 'contacts', 'properties', 'memberships', 'lead_events'];
  const { rows } = await db.query("select c.relname as name,coalesce(c.relacl::text[],array[]::text[]) as acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname=any($1::text[]) order by c.relname", [names]);
  if (rows.length !== names.length) throw new Error('Base ACL relation set incomplete');
  const file = new URL('./expected/privileges.pre.json', import.meta.url);
  const expected = JSON.parse(readFileSync(file, 'utf8'));
  expected.base_relacl = Object.fromEntries(rows.map(row => [row.name, [...row.acl].sort()]));
  writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
} finally { await db.end(); }
