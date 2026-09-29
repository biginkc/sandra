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
const artifactPaths = ['function-grants.json', 'function-owners.json', 'relation-owners.json'].map(name => `experiments/inbox-production-install/${name}`);
const read = file => execFileSync('git', ['show', `${sourceCommit}:${file}`], { encoding: 'utf8' });
const sha = text => createHash('sha256').update(text).digest('hex');
const artifacts = Object.fromEntries(artifactPaths.map(file => [path.basename(file), { sha256: sha(read(file)), value: JSON.parse(read(file)) }]));
const functions = {};
const migrationSql = paths.map(read).join('\n');
for (const file of paths) {
  const sql = read(file);
  for (const match of sql.matchAll(/\bCREATE(?: OR REPLACE)? FUNCTION\s+([a-z_][\w]*\.[a-z_][\w]*)\s*\(([^]*?)\)\s+([^]*?)\bAS\s+\$\$/gi)) {
    const key = match[1].toLowerCase();
    if (!key.startsWith('inbox_') && !key.startsWith('public.inbox_')) continue;
    const header = match[3];
    const searchPath = (header.match(/\bSET\s+search_path\s*=\s*([^\n]+?)(?=\s+AS\s*\$\$|$)/i)?.[1]?.trim() ?? '').replace(/^'|'$/g, '');
    functions[key] = { secdef: /\bSECURITY DEFINER\b/i.test(header), owner: 'postgres', search_path: searchPath, execute: (artifacts['function-grants.json'].value[key] ?? []).map(grant => grant.grantee).sort() };
  }
}
const grants = artifacts['function-grants.json'].value;
const owners = artifacts['function-owners.json'].value;
for (const key of Object.keys(owners)) if (!(key in functions)) throw new Error(`Missing function declaration: ${key}`);
for (const key of Object.keys(owners)) if (!(key in grants) || owners[key] !== 'postgres') throw new Error(`Missing grant/owner pin: ${key}`);
for (const match of migrationSql.matchAll(/\bGRANT\s+EXECUTE\s+ON\s+FUNCTION\s+([^;]+?)\s+TO\s+(anon|authenticated|service_role)\s*;/gi)) {
  const role = match[2].toLowerCase();
  for (const fn of match[1].matchAll(/([a-z_][\w]*\.[a-z_][\w]*)\s*\(/gi)) {
    const key = fn[1].toLowerCase();
    if (functions[key] && !functions[key].execute.includes(role)) functions[key].execute.push(role);
  }
}
for (const entry of Object.values(functions)) entry.execute.sort();
const relations = { ...artifacts['relation-owners.json'].value };
for (const match of migrationSql.matchAll(/\bCREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?(inbox_[a-z_]+)/gi)) relations[`schema:${match[1].toLowerCase()}`] = 'postgres';
for (const match of migrationSql.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(inbox_[a-z_]+\.[a-z_][\w]*|public\.inbox_inbound_heads)/gi)) relations[`table:${match[1].toLowerCase()}`] = 'postgres';
const expected = { source_commit: sourceCommit, source_sha256: Object.fromEntries(paths.map(file => [file, sha(read(file))])), artifact_sha256: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, value.sha256])), functions, relation_owners: relations };
const dir = path.join('scripts', 'outbox-db-contract', 'expected'); mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'privileges.post.json'), `${JSON.stringify(expected, null, 2)}\n`);
writeFileSync(path.join(dir, 'privileges.pre.json'), `${JSON.stringify({ message_triggers: ['trg_messages_fill_sms_conversation_id', 'guard_training_messages', 'messages_reject_dnc_locked_read'] }, null, 2)}\n`);
