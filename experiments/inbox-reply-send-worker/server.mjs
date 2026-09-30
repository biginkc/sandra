import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRunner } from './runner.mjs';
import { dispatchBatch, workerConfiguration, createReadinessProbe, createRestateReadinessProbe, databaseConfiguration } from './core.mjs';

/**
 * Keep the Restate deployment identity in the URL path. The exported handler
 * lets the fixture exercise this exact server routing contract without a DB.
 */
export function createWorkerRequestHandler({ endpoint, registrationPath, isStopping = () => false, getLastDispatchOk = () => 0, readiness = async () => true, now = Date.now }) {
  return async (req, res) => {
    if (req.url === '/livez') {
      const live = !isStopping();
      res.writeHead(live ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ live })); return;
    }
    if (req.url === '/readyz') {
      let healthy = false;
      try { healthy = !isStopping() && now() - getLastDispatchOk() < 5000 && await readiness(); } catch { }
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ready: healthy })); return;
    }
    if (isStopping()) { res.writeHead(503); res.end(); return; }
    const restatePrefix = `${registrationPath}/`;
    if (!req.url.startsWith(restatePrefix)) { res.writeHead(404); res.end(); return; }
    const originalUrl = req.url; req.url = req.url.slice(registrationPath.length) || '/';
    try { return await endpoint(req, res); } finally { req.url = originalUrl; }
  };
}

async function start() {
  if (process.env.INBOX_REPLY_SEND_WORKER_ENABLED !== '1') throw Error('Inbox reply-send worker is disabled');
  if (!process.env.INBOX_REPLY_SEND_DATABASE_URL || !process.env.INBOX_RESTATE_INGRESS_URL) throw Error('Private worker configuration missing');
  const { default: pg } = await import('pg');
  const restate = await import('@restatedev/restate-sdk');
  const { createEndpointHandler } = await import('@restatedev/restate-sdk/node');
  const { ingress, identityKeys, connections, registrationPath } = workerConfiguration(process.env);
  const pool = new pg.Pool({ ...databaseConfiguration(process.env), max: connections, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 15000, query_timeout: 20000, application_name: 'sandra-inbox-reply-send-worker' });
  const authority = (await pool.query(`SELECT current_user AS role,
 NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
 AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS constrained
 FROM pg_roles r WHERE r.rolname=current_user`)).rows[0];
  if (authority?.role !== 'inbox_reply_send_worker' || authority.constrained !== true) throw Error('Dedicated constrained reply-send worker role required');
  // The real production seam. NEVER invoked in proofs — proofs inject a
  // fault-injectable double via INBOX_REPLY_SEND_TEST_TRANSPORT_MODULE instead,
  // and admission stays closed / flags stay off in every environment this
  // worker actually runs against in this PR.
  async function loadTransport() {
    if (process.env.INBOX_ACTION_LOCAL_FIXTURE === '1' && process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_MODULE) {
      const mod = await import(process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_MODULE);
      return mod.createTestReplyTransport();
    }
    // Vendored, type-erased runtime copy; the image has no TypeScript toolchain.
    const { createSendilloReplyTransport } = await import('./vendor/reply-provider.mjs');
    const apiKey = process.env.SENDILLO_API_KEY;
    if (!apiKey) throw Error('Sendillo API key required');
    return createSendilloReplyTransport(apiKey);
  }
  const transport = await loadTransport();
  const runner = createRunner(pool, transport);
  const service = restate.service({ name: 'InboxReplySend', handlers: { run: async (ctx, input) => {
    if (!input || typeof input !== 'object' || Object.keys(input).length !== 2) throw Error('Invalid reply dispatch request');
    const orgId = String(input.orgId), operationId = String(input.operationId);
    const attemptIds = await ctx.run('list-attempts', () => runner.operationAttempts(orgId, operationId));
    const results = [];
    for (const attemptId of attemptIds) {
      // [Astra B2] A deferred/not_sent outcome is NEVER a value this
      // durable step may return normally. A thrown, non-terminal error is
      // retried by Restate; only the dispatch receipt or a ledger-backed
      // settled state is memoized.
      const dispatch = await ctx.run(`dispatch:${attemptId}`, async () => {
        const result = await runner.dispatchAttempt(orgId, operationId, attemptId);
        if (result.kind !== 'settled' && result.kind !== 'dispatched') throw Error(`reply attempt ${attemptId} not yet settled: ${result.kind}${result.reason ? `(${result.reason})` : ''}`);
        return result;
      });
      const outcome = dispatch.kind === 'settled'
        ? dispatch
        : await ctx.run(`persist:${attemptId}`, async () => runner.persistAttempt(orgId, operationId, attemptId, dispatch));
      results.push(outcome);
    }
    const acknowledged = await ctx.run('ack-if-complete', async () => {
      // Every attempt above is 'settled' by the time we reach here (the
      // loop above cannot exit early with a deferred/not_sent outcome
      // still pending — it would have thrown and Restate would have
      // retried that step before ever reaching this line), so this is
      // read-only confirmation, never a reason by itself to defer.
      return (await pool.query('SELECT inbox_reply_send.operation_dispatch_complete($1,$2) AS ready', [orgId, operationId])).rows[0]?.ready === true;
    });
    return { operationId, attempts: results, complete: acknowledged };
  } } });
  const endpoint = createEndpointHandler({ services: [service], identityKeys });
  let stopping = false, lastDispatchOk = 0, inflight;
  const engineReadiness = createRestateReadinessProbe(fetch, ingress);
  const readiness = createReadinessProbe(async () => await engineReadiness.read());
  async function dispatch() {
    if (stopping) return;
    try { if (!await readiness.read()) { lastDispatchOk = 0; return; } await dispatchBatch(pool, fetch, ingress); lastDispatchOk = Date.now(); }
    catch { lastDispatchOk = 0; readiness.invalidate(); process.stderr.write('Inbox reply-send dispatch unavailable; durable outbox retained\n'); }
  }
  const timer = setInterval(() => { if (!inflight) inflight = dispatch().finally(() => { inflight = undefined; }); }, 1000);
  const server = http.createServer(createWorkerRequestHandler({ endpoint, registrationPath, isStopping: () => stopping, getLastDispatchOk: () => lastDispatchOk, readiness: () => readiness.read() }));
  server.listen(Number(process.env.PORT ?? 9081), process.env.INBOX_WORKER_BIND ?? '127.0.0.1');
  async function shutdown() { if (stopping) return; stopping = true; clearInterval(timer); server.close(); await inflight; await pool.end(); }
  process.once('SIGTERM', () => { void shutdown(); }); process.once('SIGINT', () => { void shutdown(); });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await start();
