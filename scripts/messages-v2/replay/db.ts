import type { Query } from "./schema";

type Client = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

/**
 * Run `fn` inside `begin transaction read only` with a statement timeout, and
 * ALWAYS roll back. Postgres itself rejects any write in this transaction.
 */
export async function withReadOnlyTransaction<T>(
  client: Client,
  fn: (query: Query) => Promise<T>,
  opts: { statementTimeoutMs?: number } = {},
): Promise<T> {
  const timeout = Math.max(1000, Math.floor(opts.statementTimeoutMs ?? 60_000));
  await client.query("begin transaction read only");
  try {
    await client.query(`set local statement_timeout = ${timeout}`);
    return await fn((sql, params) => client.query(sql, params));
  } finally {
    await client.query("rollback");
  }
}

/** Run `fn` in a normal transaction; commit on success, roll back on error. */
export async function withTransaction<T>(client: Client, fn: (query: Query) => Promise<T>): Promise<T> {
  await client.query("begin");
  try {
    const out = await fn((sql, params) => client.query(sql, params));
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}
