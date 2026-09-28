import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/supabase/types';

export type OwnedTable =
  | 'organizations' | 'memberships' | 'provider_sender_numbers'
  | 'provider_campaigns' | 'properties' | 'contacts' | 'messages'
  | 'lead_events' | 'auth.users' | 'message_threads';
export type OwnedRow = { table: OwnedTable; id: string; property_id?: string; retained?: string };
const cleanupOrder: OwnedTable[] = [
  'messages', 'message_threads', 'properties', 'contacts', 'provider_sender_numbers',
  'provider_campaigns', 'memberships', 'auth.users', 'organizations',
];
const uuidPattern = /^[0-9a-f-]{36}$/i;

export function ownedRowsFile(): string {
  if (!process.env.OUTBOX_RUN_DIR) throw new Error('OUTBOX_RUN_DIR is required');
  return path.join(process.env.OUTBOX_RUN_DIR, 'fixture-rows.json');
}

export function readOwnedRows(): OwnedRow[] {
  const file = ownedRowsFile();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as OwnedRow[] : [];
}

export function recordOwnedRow(table: OwnedTable, id: string, property_id?: string): void {
  if (!uuidPattern.test(id)) throw new Error(`Invalid owned ${table} id`);
  const file = ownedRowsFile();
  const rows = readOwnedRows();
  if (!rows.some(row => row.table === table && row.id === id)) {
    rows.push({
      table, id,
      ...(property_id ? { property_id } : {}),
      ...(table === 'auth.users' ? { retained: 'managed by e2e-identity-lifecycle' } : {}),
    });
  }
  fs.writeFileSync(file, `${JSON.stringify(rows, null, 2)}\n`);
}

export async function cleanupOwnedRows(
  client: SupabaseClient<Database>,
  orgId: string,
  rows: readonly OwnedRow[],
): Promise<void> {
  if (!uuidPattern.test(orgId) || rows.some(row =>
    (row.table !== 'lead_events' && !cleanupOrder.includes(row.table)) || !uuidPattern.test(row.id) ||
    (row.table === 'organizations' && row.id !== orgId)
  )) throw new Error('Invalid cleanup ledger');

  // The append-only audit ledger cannot be deleted. Keep its referenced
  // property and organization; unlink only that recorded property's contact.
  const retainedProperties = new Set(
    rows.filter(row => row.table === 'lead_events').map(row => row.property_id),
  );
  for (const table of cleanupOrder) {
    for (const row of rows.filter(item => item.table === table)) {
      if (table === 'properties' && retainedProperties.has(row.id)) {
        const { error } = await client.from('properties')
          .update({ homeowner_contact_id: null, agent_contact_id: null })
          .eq('org_id', orgId).eq('id', row.id);
        if (error) throw error;
        continue;
      }
      // Auth identities belong to e2e-identity-lifecycle and disposable DB teardown.
      if (table === 'auth.users') continue;
      // The final owner trigger prevents deleting the sole owner membership.
      // Keep that exact recorded membership and organization together.
      if (rows.some(item => item.table === 'memberships') &&
          (table === 'memberships' || table === 'organizations')) continue;
      if (table === 'organizations' && retainedProperties.size > 0) continue;
      if (table === 'organizations') {
        const { error } = await client.from('organizations').delete().eq('id', orgId);
        if (error) throw error;
        continue;
      }
      // Every public-table delete has both the exact org and recorded ID.
      const { error } = await client.from(table).delete().eq('org_id', orgId).eq('id', row.id);
      if (error) throw new Error(`Owned cleanup ${table}/${row.id}: ${error.message}`);
    }
  }
}
