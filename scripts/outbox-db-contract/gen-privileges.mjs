import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const paths = [
  'supabase/migrations/20260930020000_inbox_control_foundation.sql',
  'supabase/migrations/20260930020100_inbox_read_companion.sql',
  'supabase/migrations/20260930020200_inbox_backend_operation_reply.sql',
];
const read = file => readFileSync(file, 'utf8');
const sha = text => createHash('sha256').update(text).digest('hex');
const functions = {};
const migrationSql = paths.map(read).join('\n');
const events = [];
for (const file of paths) {
  const sql = read(file);
  for (const match of sql.matchAll(/\bCREATE(?: OR REPLACE)? FUNCTION\s+([a-z_][\w]*\.[a-z_][\w]*)\s*\(([^]*?)\)\s+([^]*?)\bAS\s+\$\$/gi)) {
    const key = match[1].toLowerCase();
    if (!key.startsWith('inbox_') && !key.startsWith('public.inbox_')) continue;
    const header = match[3];
    const searchPath = header.match(/\bSET\s+search_path\s*=\s*'([^']*)'/i)?.[1] ?? null;
    functions[key] = { secdef: /\bSECURITY DEFINER\b/i.test(header), owner: 'postgres', search_path: searchPath, execute: [] };
  }
}
// The checked-in grant artifact predates backend-operation/reply functions and
// omits later explicit grants. Parse the migration source instead of filling
// gaps from a live catalog, which would make the pin self-fulfilling.
const acl = Object.fromEntries(Object.keys(functions).map(key => [key, new Set()]));
const functionNames = text => [...text.matchAll(/([a-z_][\w]*\.[a-z_][\w]*)\s*\(/gi)].map(match => match[1].toLowerCase()).filter(key => key in functions);
const roles = text => text.toLowerCase().split(',').map(role => role.trim()).filter(role => ['anon', 'authenticated', 'service_role', 'public'].includes(role));
for (const match of migrationSql.matchAll(/\b(GRANT\s+EXECUTE|REVOKE\s+ALL)\s+ON\s+FUNCTION\s+([^;]+?)\s+(?:TO|FROM)\s+([a-z_,\s]+?)\s*;/gi)) {
  events.push({ at: match.index, add: match[1].toUpperCase().startsWith('GRANT'), names: functionNames(match[2]), roles: roles(match[3]) });
}
for (const match of migrationSql.matchAll(/\bREVOKE\s+ALL\s+ON\s+ALL\s+FUNCTIONS\s+IN\s+SCHEMA\s+([a-z_,\s]+?)\s+FROM\s+([a-z_,\s]+?)\s*;/gi)) {
  const schemas = match[1].toLowerCase().split(',').map(value => value.trim());
  events.push({ at: match.index, add: false, names: Object.keys(functions).filter(key => schemas.some(schema => key.startsWith(`${schema}.`))), roles: roles(match[2]) });
}
// The bundle's final hardening loops revoke from every reviewed private schema.
for (const match of migrationSql.matchAll(/FOREACH n IN ARRAY ARRAY\[([^\]]+)\] LOOP[\s\S]*?REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM PUBLIC,anon,authenticated,service_role/gi)) {
  const schemas = [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
  events.push({ at: match.index, add: false, names: Object.keys(functions).filter(key => schemas.some(schema => key.startsWith(`${schema}.`))), roles: ['public', 'anon', 'authenticated', 'service_role'] });
}
// Reply-send's dynamic role loop is equivalent to revoking all public roles.
for (const match of migrationSql.matchAll(/REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_reply_send FROM %I/gi)) {
  events.push({ at: match.index, add: false, names: Object.keys(functions).filter(key => key.startsWith('inbox_reply_send.')), roles: ['public', 'anon', 'authenticated', 'service_role'] });
}
for (const event of events.sort((a, b) => a.at - b.at)) for (const name of event.names) for (const role of event.roles) {
  if (event.add) acl[name].add(role); else acl[name].delete(role);
}
for (const [name, entry] of Object.entries(functions)) entry.execute = ['anon', 'authenticated', 'service_role'].filter(role => acl[name].has('public') || acl[name].has(role));
const relations = {};
for (const match of migrationSql.matchAll(/\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(inbox_[a-z_]+)/gi)) relations[`schema:${match[1].toLowerCase()}`] = 'postgres';
for (const match of migrationSql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(inbox_[a-z_]+\.[a-z_][\w]*|public\.inbox_inbound_heads)/gi)) relations[`table:${match[1].toLowerCase()}`] = 'postgres';
const expected = { source_sha256: Object.fromEntries(paths.map(file => [file, sha(read(file))])), functions, relation_owners: relations };
const dir = path.join('scripts', 'outbox-db-contract', 'expected'); mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'privileges.post.json'), `${JSON.stringify(expected, null, 2)}\n`);
// The pre pin is generated from a live disposable-from-main catalog by gen-base-acl.mjs.
