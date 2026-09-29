import { readFileSync } from 'node:fs';

export function connectionConfig(target, dsn, env = process.env) {
  const hosted = target === 'shared-readonly' || target === 'production';
  if (!hosted && target !== 'disposable-readonly') throw new Error('TARGET_REFUSED');
  const ca = env.NODE_EXTRA_CA_CERTS ? readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8') : undefined;
  return { connectionString: dsn, ssl: hosted ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) } : false };
}

export async function assertBackendTls(client) {
  const row = (await client.query('SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0];
  if (row?.ssl !== true) throw new Error('TLS_REQUIRED');
  return { ssl: true, version: row.version, cipher: row.cipher };
}
