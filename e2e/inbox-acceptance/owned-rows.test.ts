import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../src/lib/supabase/types';
import { cleanupOwnedRows, readOwnedRows, recordOwnedRow, type OwnedRow } from './owned-rows';

const org = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
function fakeClient() {
  const calls: string[] = [];
  const client = {
    from(table: string) {
      calls.push(`from:${table}`);
      const query = {
        delete() { calls.push('delete'); return query; },
        update() { calls.push('update'); return query; },
        eq(column: string, value: string) { calls.push(`eq:${column}:${value}`); return query; },
        then(resolve: (value: {error: null}) => void) { resolve({error: null}); },
      };
      return query;
    },
    auth: { admin: new Proxy({}, { get() { calls.push('auth-admin-access'); throw new Error('Auth admin mutation must be impossible'); } }) },
    rpc() { throw new Error('RPC must be impossible'); },
  };
  return { client: client as unknown as SupabaseClient<Database>, calls };
}
describe('owned cleanup', () => {
  it('records the auth identity as retained by its lifecycle', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'outbox-owned-'));
    const previous = process.env.OUTBOX_RUN_DIR;
    try {
      process.env.OUTBOX_RUN_DIR = dir;
      recordOwnedRow('auth.users', id);
      expect(readOwnedRows()).toEqual([{table:'auth.users',id,retained:'managed by e2e-identity-lifecycle'}]);
    } finally {
      if (previous === undefined) delete process.env.OUTBOX_RUN_DIR;
      else process.env.OUTBOX_RUN_DIR = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('retains a recorded auth identity without accessing auth admin', async () => {
    const {client,calls} = fakeClient();
    await cleanupOwnedRows(client, org, [{table:'auth.users',id}]);
    expect(calls).toEqual([]);
  });
  it('deletes only recorded IDs with both org and id predicates', async () => {
    const { client, calls } = fakeClient();
    await cleanupOwnedRows(client, org, [{table:'messages',id}]);
    expect(calls).toEqual(['from:messages','delete',`eq:org_id:${org}`,`eq:id:${id}`]);
  });
  it('has no reset or org-wide delete path for an empty ledger', async () => {
    const {client,calls} = fakeClient();
    await cleanupOwnedRows(client, org, []);
    expect(calls).toEqual([]);
  });
  it('retains audited properties and scopes the unlink to the recorded ID', async () => {
    const {client,calls} = fakeClient();
    const eventId = '33333333-3333-4333-8333-333333333333';
    await cleanupOwnedRows(client, org, [
      {table:'properties',id},
      {table:'lead_events',id:eventId,property_id:id},
      {table:'organizations',id:org},
    ]);
    expect(calls).toEqual(['from:properties','update',`eq:org_id:${org}`,`eq:id:${id}`]);
  });
  it('rejects unlisted tables and invalid IDs before mutation', async () => {
    const {client,calls} = fakeClient();
    await expect(cleanupOwnedRows(client, org, [{table:'unlisted',id} as unknown as OwnedRow])).rejects.toThrow('Invalid cleanup ledger');
    await expect(cleanupOwnedRows(client, org, [{table:'messages',id:'bad'}])).rejects.toThrow('Invalid cleanup ledger');
    expect(calls).toEqual([]);
  });
});
