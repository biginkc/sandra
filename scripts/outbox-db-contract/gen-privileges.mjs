import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const sourceCommit = 'e767bec7';
const paths = [
  'supabase/migrations/20260929000000_inbox_control_foundation.sql',
  'supabase/migrations/20260929000100_inbox_read_companion.sql',
  'supabase/migrations/20260929000200_inbox_backend_operation_reply.sql',
];
const read = file => execFileSync('git', ['show', `${sourceCommit}:${file}`], { encoding: 'utf8' });
const sha = text => createHash('sha256').update(text).digest('hex');
const functions = {};
const migrationSql = paths.map(read).join('\n');
for (const file of paths) {
  const sql = read(file);
  for (const match of sql.matchAll(/\bCREATE(?: OR REPLACE)? FUNCTION\s+([a-z_][\w]*\.[a-z_][\w]*)\s*\(([^]*?)\)\s+([^]*?)\bAS\s+\$\$/gi)) {
    const key = match[1].toLowerCase();
    if (!key.startsWith('inbox_') && !key.startsWith('public.inbox_')) continue;
    const header = match[3];
    const searchPath = (header.match(/\bSET\s+search_path\s*=\s*([^\n]+?)(?=\s+AS\s*\$\$|$)/i)?.[1]?.trim() ?? '').replace(/^'|'$/g, '');
    functions[key] = { secdef: /\bSECURITY DEFINER\b/i.test(header), owner: 'postgres', search_path: searchPath, execute: [] };
  }
}
// The checked-in grant artifact predates backend-operation/reply functions and
// omits later explicit grants. Parse the migration source instead of filling
// gaps from a live catalog, which would make the pin self-fulfilling.
for (const match of migrationSql.matchAll(/\bGRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([^;]+?)\s+TO\s+(anon|authenticated|service_role)\s*;/gi)) {
  const role = match[2].toLowerCase();
  for (const fn of match[1].matchAll(/([a-z_][\w]*\.[a-z_][\w]*)\s*\(/gi)) {
    const key = fn[1].toLowerCase();
    if (functions[key] && !functions[key].execute.includes(role)) functions[key].execute.push(role);
  }
}
for (const entry of Object.values(functions)) entry.execute.sort();
const relations = {};
for (const match of migrationSql.matchAll(/\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(inbox_[a-z_]+)/gi)) relations[`schema:${match[1].toLowerCase()}`] = 'postgres';
for (const match of migrationSql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(inbox_[a-z_]+\.[a-z_][\w]*|public\.inbox_inbound_heads)/gi)) relations[`table:${match[1].toLowerCase()}`] = 'postgres';
const expected = { source_commit: sourceCommit, source_sha256: Object.fromEntries(paths.map(file => [file, sha(read(file))])), functions, relation_owners: relations };
const dir = path.join('scripts', 'outbox-db-contract', 'expected'); mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'privileges.post.json'), `${JSON.stringify(expected, null, 2)}\n`);
// The pre pin is generated from a live disposable-from-main catalog by gen-base-acl.mjs.
