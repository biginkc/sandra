/** Invoke the actual source classifier against already SQL-filtered fixture rows. */
import { readFileSync } from 'node:fs';
import { listUnknownSenders } from '../../../src/lib/messages/list-unknown-senders';

async function main() {
  const rows = JSON.parse(readFileSync(0, 'utf8'));
  // The query reader supplies rows sorted by created_at. Grouping/filtering below
  // is the real implementation, not a second implementation of its algorithm.
  const query = {
    select: () => query, eq: () => query, is: () => query, not: () => query,
    order: () => query,
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
  const client = { from: () => query } as unknown as Parameters<typeof listUnknownSenders>[0];
  process.stdout.write(JSON.stringify({
    all: await listUnknownSenders(client, { includeDismissed: true }),
    active: await listUnknownSenders(client, {}),
  }));
}
void main();
