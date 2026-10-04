import { readFileSync } from 'node:fs';
import type { Client } from 'pg';

// The P1e migrations create tables and functions without `if not exists` (production DDL stays
// strict). In CI the disposable database is already fully migrated, locally it may not be, so the
// integration suites call applyP1e() inside their rolled-back transaction: it first removes any
// P1e objects with the migrations' own rollback twins (only when present), then applies the
// requested migrations. Both starting states end identically, and the caller rolls everything back.
const root = new URL('../../supabase/', import.meta.url);

export const MIGRATIONS = {
  tools: 'migrations/20261005100000_my_leads_housekeeping_tools.sql',
  reassign: 'migrations/20261005100100_my_leads_housekeeping_reassign.sql',
  outcome: 'migrations/20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql',
} as const;
export const ROLLBACKS = {
  tools: 'rollbacks/20261005100000_my_leads_housekeeping_tools.sql',
  reassign: 'rollbacks/20261005100100_my_leads_housekeeping_reassign.sql',
  outcome: 'rollbacks/20261005110000_acquisition_attempt_outcome_voicemail_not_logged.sql',
} as const;

export function readSql(relative: string): string {
  return readFileSync(new URL(relative, root), 'utf8');
}

export function stripTransaction(relative: string): string {
  const sql = readSql(relative);
  if (!/^[\s\S]*?\bbegin;\s*/im.test(sql) || !/\s*commit;\s*$/i.test(sql)) throw new Error(`${relative}: transaction wrapper changed`);
  return sql.replace(/^begin;\s*/im, '').replace(/\s*commit;\s*$/i, '');
}

export async function applyP1e(db: Client, through: keyof typeof MIGRATIONS): Promise<void> {
  const present = (await db.query("select to_regclass('public.my_leads_housekeeping_runs') as t")).rows[0].t;
  if (present) {
    for (const key of ['outcome', 'reassign', 'tools'] as const) await db.query(stripTransaction(ROLLBACKS[key]));
  }
  const order = ['tools', 'reassign', 'outcome'] as const;
  for (const key of order.slice(0, order.indexOf(through) + 1)) await db.query(stripTransaction(MIGRATIONS[key]));
}
