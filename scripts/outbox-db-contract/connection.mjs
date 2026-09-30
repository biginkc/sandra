import { readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import tls from 'node:tls';

export const PINNED_CA_FINGERPRINT = '80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA';
const fingerprint = raw => createHash('sha256').update(raw).digest('hex').toUpperCase().match(/../g).join(':');
export function pinnedCa(env = process.env, expected = PINNED_CA_FINGERPRINT) {
  if (!env.NODE_EXTRA_CA_CERTS) throw new Error('TLS_CA_REQUIRED');
  let pem, cert;
  try {
    pem = readFileSync(env.NODE_EXTRA_CA_CERTS, 'utf8');
    if ((pem.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1) throw new Error('single CA required');
    cert = new X509Certificate(pem);
  } catch { throw new Error('TLS_CA_INVALID'); }
  if (fingerprint(cert.raw) !== expected) throw new Error('TLS_CA_PIN_MISMATCH');
  return { path: env.NODE_EXTRA_CA_CERTS, pem, cert };
}
export function connectionConfig(target, dsn, env = process.env, expected = PINNED_CA_FINGERPRINT) {
  const hosted = target === 'shared-readonly' || target === 'production';
  if (!hosted && target !== 'disposable-readonly') throw new Error('TARGET_REFUSED');
  if (!hosted) return { connectionString: dsn, ssl: false };
  const u = new URL(dsn);
  if ([...u.searchParams.keys()].some(key => /^ssl/i.test(key))) throw new Error('TARGET_REFUSED');
  const { pem } = pinnedCa(env, expected);
  return { host: u.hostname, port: Number(u.port || 5432), user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password), database: decodeURIComponent(u.pathname.slice(1)),
    ssl: { rejectUnauthorized: true, ca: pem, servername: u.hostname,
    checkServerIdentity: tls.checkServerIdentity, minVersion: 'TLSv1.2' } };
}
export async function clientTlsEvidence(client, host, ca, expected = PINNED_CA_FINGERPRINT) {
  const config = client.connectionParameters?.ssl;
  if (config?.rejectUnauthorized !== true || config.ca !== (ca?.pem ?? ca) ||
      config.servername !== host || config.checkServerIdentity !== tls.checkServerIdentity ||
      config.minVersion !== 'TLSv1.2') throw new Error('TLS_CONFIG_DOWNGRADE');
  const socket = client.connection?.stream;
  if (!(socket instanceof tls.TLSSocket) || socket.encrypted !== true || socket.authorized !== true) throw new Error('TLS_SOCKET_UNVERIFIED');
  const protocol = socket.getProtocol();
  if (!['TLSv1.2', 'TLSv1.3'].includes(protocol)) throw new Error('TLS_PROTOCOL_REFUSED');
  const leaf = socket.getPeerCertificate(true);
  if (!leaf?.raw || tls.checkServerIdentity(host, leaf) !== undefined) throw new Error('TLS_HOSTNAME_MISMATCH');
  const root = new X509Certificate(ca?.pem ?? ca);
  if (fingerprint(root.raw) !== expected) throw new Error('TLS_CA_PIN_MISMATCH');
  const visited = new Set();
  let member = leaf, rootInChain = false, complete = false;
  while (member?.raw) {
    const digest = fingerprint(member.raw);
    if (visited.has(digest)) break;
    visited.add(digest);
    if (digest === expected) { rootInChain = true; complete = true; break; }
    const next = member.issuerCertificate;
    if (!next?.raw || fingerprint(next.raw) === digest) {
      const last = new X509Certificate(member.raw);
      complete = last.issuer === root.subject && last.verify(root.publicKey);
      break;
    }
    member = next;
  }
  if (!complete) throw new Error('TLS_CHAIN_INCOMPLETE');
  const cipher = socket.getCipher()?.name;
  if (!cipher) throw new Error('TLS_CIPHER_MISSING');
  return { protocol, cipher, leaf_fingerprint: fingerprint(leaf.raw), pinned_ca_fingerprint: expected,
    root_in_peer_chain: rootInChain };
}
export async function connectionEvidence(client, dsn, ca, expected = PINNED_CA_FINGERPRINT) {
  const evidence = await clientTlsEvidence(client, new URL(dsn).hostname, ca, expected);
  let row = null;
  try { row = (await client.query('SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0] ?? null; }
  catch { /* Backend hop visibility is informational, never a TLS gate. */ }
  return { ...evidence, upstream_hop_ssl: row };
}
