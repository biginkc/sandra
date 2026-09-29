import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import { assertWriteMode } from './guards.mjs';

const dbUrl = process.env.E2E_CI_SUPABASE_DB_URL;
assertWriteMode('disposable', { apiUrl: process.env.TEST_SUPABASE_URL, dbUrl, env: process.env });
const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
try {
  const { rows } = await db.query("select n.nspname||'.'||c.relname as name,c.relrowsecurity as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and (n.nspname like 'inbox_%' or (n.nspname='public' and c.relname='inbox_inbound_heads')) order by 1");
  const file = new URL('./expected/privileges.post.json', import.meta.url);
  const expected = JSON.parse(readFileSync(file, 'utf8'));
  const names = Object.keys(expected.relation_owners).filter(key => key.startsWith('table:')).map(key => key.slice(6)).sort();
  if (JSON.stringify(rows.map(row => row.name)) !== JSON.stringify(names)) throw new Error('Post relation set differs from migration source inventory');
  expected.relation_rls = Object.fromEntries(rows.map(row => [row.name, row.rls]));
  const functions = (await db.query("select n.nspname||'.'||p.proname as name,p.oid::regprocedure::text as signature,p.prosecdef as secdef,pg_get_userbyid(p.proowner) as owner,coalesce((select regexp_replace(x,'^search_path=','') from unnest(p.proconfig) x where x like 'search_path=%'),'') as search_path from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname like 'inbox_%' or (n.nspname='public' and p.proname like 'inbox_%') order by 1,2")).rows;
  if (JSON.stringify([...new Set(functions.map(row => row.name))].sort()) !== JSON.stringify(Object.keys(expected.functions).sort())) throw new Error('Post function set differs from migration source inventory');
  for (const fn of functions) {
    const allowed = (await db.query("select role from unnest(array['anon','authenticated','service_role']::text[]) role where has_function_privilege(role,$1,'EXECUTE') order by role", [fn.signature])).rows.map(row => row.role);
    const current = expected.functions[fn.name].execute;
    if (current && current.length && JSON.stringify(current) !== JSON.stringify(allowed) && functions.filter(row => row.name === fn.name).length > 1) throw new Error(`Overload grants differ: ${fn.name}`);
    expected.functions[fn.name].execute = allowed;
    for (const property of ['secdef', 'owner', 'search_path']) expected.functions[fn.name][property] = fn[property];
  }
  writeFileSync(file, `${JSON.stringify(expected, null, 2)}\n`);
} finally { await db.end(); }
