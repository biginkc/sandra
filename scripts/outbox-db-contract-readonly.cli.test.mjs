import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './outbox-db-contract-readonly.mjs';
import { describePlan } from './outbox-db-contract/plan-contract.mjs';

const plan = scan => describePlan({ 'Node Type': scan, 'Relation Name': 'messages', Schema: 'public', 'Index Name': 'messages_queue_idx', 'Total Cost': 10 });
const plans = scan => Object.fromEntries(['privileged', 'member'].map(role => [role, Object.fromEntries(['first', 'keyset', 'null_tail'].map(shape => [shape, plan(scan)]))]));

test('CLI plan comparison fails on regression even when operator indexes are not built', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'readonly-plan-cli-'));
  const previous = process.env.E2E_DISPOSABLE_DATABASE;
  const previousDsn = process.env.DATABASE_URL;
  process.env.E2E_DISPOSABLE_DATABASE = '1';
  process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:55422/postgres';
  try {
    const pre = { target: 'disposable-readonly', phase: 'pre', queued: { count: 0, per_row: {} }, catalog_indexes: {}, plans: plans('Index Scan') };
    const preFile = path.join(dir, 'pre.json');
    writeFileSync(preFile, JSON.stringify(pre));
    for (const [scan, expectedVerdict] of [['Seq Scan', 'FAIL'], ['Index Scan', 'INCONCLUSIVE']]) {
      const output = path.join(dir, `${scan.replace(' ', '-')}.json`);
      const client = { connect: async () => {}, end: async () => {}, query: async () => ({ rows: [{ server_version_num: '170000' }] }) };
      const argv = { target: 'disposable-readonly', phase: 'post', org: '00000000-0000-0000-0000-000000000001', catalog: true, 'pre-file': preFile, 'plan-compare': preFile, output };
      await assert.rejects(main({ argv, createClient: () => client, collectData: async () => ({ queued: pre.queued, current_status: {}, plans: plans(scan) }), readCatalog: async () => ({ sections: { relations: [] } }) }), expectedVerdict === 'FAIL' ? /FAIL PLAN_REGRESSION/ : /INCONCLUSIVE INDEXES_NOT_BUILT/);
      const result = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(result.verdict, expectedVerdict);
      assert.equal(result.items.indexes.reason, 'INDEXES_NOT_BUILT');
      if (expectedVerdict === 'FAIL') assert.match(result.items.plans.reason, /member null_tail/);
      else assert.equal(result.items.plans, undefined);
    }
  } finally {
    if (previousDsn === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDsn;
    if (previous === undefined) delete process.env.E2E_DISPOSABLE_DATABASE;
    else process.env.E2E_DISPOSABLE_DATABASE = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

function openssl(args, dir) {
  const result = spawnSync('openssl', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function runCli(dsn, ca, redirect) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/outbox-db-contract-readonly.mjs', '--target', 'shared-readonly', '--probe-connection'], {
      env: { ...process.env, DATABASE_URL: dsn, NODE_EXTRA_CA_CERTS: ca, NODE_OPTIONS: `--require=${redirect}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

test('CLI --probe-connection rejects a certificate outside the supplied CA', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'readonly-tls-cli-'));
  let server;
  let acceptedTls = 0;
  try {
    const host = 'aws-0-us-east-1.pooler.supabase.com';
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'server.key', '-out', 'server.pem', '-days', '1', '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`], dir);
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'wrong.key', '-out', 'wrong.pem', '-days', '1', '-subj', '/CN=unrelated.test'], dir);
    const context = createSecureContext({ key: readFileSync(path.join(dir, 'server.key')), cert: readFileSync(path.join(dir, 'server.pem')) });
    server = createServer(socket => {
      socket.once('data', request => {
        if (request.length !== 8 || request.readInt32BE(4) !== 80877103) { socket.destroy(); return; }
        socket.write('S');
        const secure = new TLSSocket(socket, { isServer: true, secureContext: context });
        secure.on('error', () => {});
        secure.on('secure', () => { acceptedTls++; secure.end(); });
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const redirect = path.join(dir, 'redirect.cjs');
    writeFileSync(redirect, `const dns = require('node:dns'); const original = dns.lookup; dns.lookup = function(host, ...rest) { return original.call(this, host === '${host}' ? '127.0.0.1' : host, ...rest); };`);
    const dsn = `postgres://postgres.ncsngxlcyxylaeskiteu:unused@${host}:${server.address().port}/postgres`;
    const run = await runCli(dsn, path.join(dir, 'wrong.pem'), redirect);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /self-signed certificate|unable to verify|certificate verify failed|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT/);
    const accepted = await runCli(dsn, path.join(dir, 'server.pem'), redirect);
    assert.equal(accepted.code, 1); // The test server ends the connection after TLS, before PostgreSQL auth.
    assert.ok(acceptedTls > 0, 'the matching CA must complete TLS before the PostgreSQL handshake ends');
    assert.doesNotMatch(accepted.stderr, /self-signed certificate|unable to verify|certificate verify failed|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT/);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
