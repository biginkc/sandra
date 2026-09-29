// Mirrors experiments/inbox-operation-worker/core.mjs's dispatchBatch/
// workerConfiguration/databaseConfiguration/readiness-probe shapes exactly,
// schema-swapped onto inbox_reply_send.* and the InboxReplySend Restate
// service. See runner.mjs for the per-attempt dispatch contract this batcher
// hands off to via the durable engine.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function id(value) { if (typeof value !== 'string' || !UUID.test(value)) throw Error('Invalid reply worker identity'); return value; }
async function transaction(pool, statement, args) {
  for (let attempt = 0; ; attempt++) {
    try { return await pool.query(statement, args); }
    catch (error) { if (attempt >= 2 || !['40P01', '40001'].includes(error?.code)) throw error; await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt)); }
  }
}
export async function dispatchBatch(pool, fetcher, ingress) {
  const entries = (await transaction(pool, 'SELECT inbox_reply_send.claim_dispatch_batch(20) AS result', [])).rows[0]?.result;
  if (!Array.isArray(entries) || entries.length > 20) throw Error('Invalid dispatch batch');
  let accepted = 0;
  // Bounded sequential dispatch; no unbounded fan-out or browser dependency.
  for (const entry of entries) {
    const orgId = id(entry.org_id), operationId = id(entry.operation_id), eventId = id(entry.event_id);
    if (typeof entry.generation !== 'string' || !/^[1-9][0-9]{0,18}$/.test(entry.generation) || BigInt(entry.generation) > 9223372036854775807n) throw Error('Invalid dispatch fence');
    // [Astra B4] /run alone is Restate's SYNCHRONOUS ingress path — it blocks
    // for the full handler result and its 200 response IS the result, not an
    // {status:'Accepted'|'PreviouslyAccepted', invocationId} envelope. /run/send
    // is the durable ASYNC path (mirrors the proven metadata worker's own
    // core.mjs) whose response is exactly the Accepted/PreviouslyAccepted
    // shape this function validates below.
    const response = await fetcher(new URL('/InboxReplySend/run/send', ingress), { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': eventId }, body: JSON.stringify({ orgId, operationId }), signal: AbortSignal.timeout(5000), redirect: 'error' });
    const body = await readBoundedJson(response, 4096);
    if (!['Accepted', 'PreviouslyAccepted'].includes(body.status) || typeof body.invocationId !== 'string' || !/^inv_[A-Za-z0-9]+$/.test(body.invocationId)) throw Error('Durable acceptance not confirmed');
    // No acknowledgment on a thrown/lost response. A later dispatcher reuses the
    // immutable event key; the SQL ledger (claim/persist) also protects past
    // engine retention.
    const acknowledgment = await transaction(pool, 'SELECT inbox_reply_send.ack_dispatch($1,$2,$3) AS result', [orgId, operationId, entry.generation]);
    // false is a legitimate outcome (ack-readiness: an attempt is still
    // approved/claimed/dispatch_started) — NOT an error. The outbox row keeps
    // its lease (still unacknowledged); it naturally expires and is retried
    // on a later pass, deferred, never journaled complete.
    if (acknowledgment.rows[0]?.result === true) accepted++;
  }
  return accepted;
}
export function workerConfiguration(env) {
  const ingress = new URL(env.INBOX_RESTATE_INGRESS_URL ?? '');
  const preview = env.NODE_ENV === 'test' && env.INBOX_ACTION_LOCAL_FIXTURE === '1' && env.INBOX_ACTION_FIXTURE_PROFILE === 'preview';
  const approved = preview ? ingress.hostname === 'sandra-inbox-preview-restate-owned' && ingress.port === '8480' : new Set(['inbox-restate.railway.internal', 'sandra-inbox-restate-owned']).has(ingress.hostname) && ingress.port === '8080';
  if (ingress.protocol !== 'http:' || !approved || ingress.username || ingress.password || ingress.search || ingress.hash || ingress.pathname !== '/') throw Error('Unapproved private Restate ingress');
  let identityKeys; try { identityKeys = JSON.parse(env.INBOX_RESTATE_IDENTITY_KEYS ?? ''); } catch { throw Error('Restate signing keys required'); }
  if (!Array.isArray(identityKeys) || identityKeys.length < 1 || identityKeys.length > 2 || identityKeys.some(k => typeof k !== 'string' || !/^publickeyv1_[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(k))) throw Error('Invalid Restate signing keys');
  const connections = Number(env.INBOX_REPLY_SEND_CONNECTIONS ?? 2);
  if (!Number.isInteger(connections) || connections < 1 || connections > 2) throw Error('Reply-send connection budget exceeds two');
  return { ingress, identityKeys, connections };
}
export function createReadinessProbe(check, clock = Date.now) {
  let pending, cached = false, until = 0, generation = 0;
  return {
    invalidate() { generation++; cached = false; until = clock() + 2000; },
    async read() {
      if (clock() < until) return cached;
      if (pending) return pending;
      const captured = generation;
      pending = (async () => { let result = false; try { result = await check() === true; } catch { }
        if (captured === generation) { cached = result; until = clock() + 2000; }
        return captured === generation ? result : false;
      })().finally(() => { pending = undefined; });
      return pending;
    },
  };
}
export function databaseConfiguration(env) {
  const url = new URL(env.INBOX_REPLY_SEND_DATABASE_URL ?? '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash || !url.username || !url.password || !['5432', '54322'].includes(url.port)) throw Error('Invalid dedicated database connection');
  const database = decodeURIComponent(url.pathname.slice(1));
  const port = Number(url.port);
  let ssl = { rejectUnauthorized: true, servername: url.hostname };
  if (env.INBOX_ACTION_LOCAL_FIXTURE === '1') {
    const profile = env.INBOX_ACTION_FIXTURE_PROFILE ?? 'proof';
    // 'reply-runtime': the RULING 1 runtime-proof targets the SAME shared
    // projection-t2 owned fixture database (postgres) that every other
    // reply-lane proof script in this repo installs its schemas into —
    // unlike the metadata worker, this PR does not stand up a second,
    // dedicated runtime-only database.
    const approved = profile === 'proof' ? url.hostname === 'sandra-inbox-actions-db-owned' && port === 5432 && database === 'sandra_inbox_action_runtime_20260913'
      : profile === 'reply-runtime' ? url.hostname === 'sandra-inbox-actions-db-owned' && port === 5432 && database === 'postgres'
      : profile === 'preview' ? url.hostname === 'sandra-inbox-preview-db-owned' && port === 5432 && database === 'sandra_inbox_install_20260913'
      : profile === 'release-http' && url.hostname === '127.0.0.1' && port === 54322 && database === 'postgres';
    if (env.NODE_ENV !== 'test' || !approved) throw Error('Unapproved plaintext fixture database');
    if (profile === 'release-http' && (
      env.INBOX_REPLY_SEND_OWNED_FIXTURE_PLAINTEXT !== 'true' ||
      env.INBOX_REPLY_SEND_FIXTURE_MARKER !== 'sandra-inbox-http-owned-synthetic-20260917' ||
      env.INBOX_REPLY_SEND_FIXTURE_OWNER !== 'release-infra' ||
      env.INBOX_REPLY_SEND_FIXTURE_PURPOSE !== 'sandra-inbox-release-http' ||
      env.INBOX_REPLY_SEND_FIXTURE_LABELS_VERIFIED !== 'true' ||
      decodeURIComponent(url.username) !== 'inbox_reply_send_worker')) throw Error('Invalid owned HTTP fixture guard');
    ssl = false;
  } else {
    if (port !== 5432) throw Error('Unapproved production database port');
    if (!url.hostname.endsWith('.supabase.co') && !url.hostname.endsWith('.pooler.supabase.com')) throw Error('Unapproved production database host');
    if (env.INBOX_REPLY_SEND_DATABASE_CA) { if (!env.INBOX_REPLY_SEND_DATABASE_CA.includes('-----BEGIN CERTIFICATE-----')) throw Error('Invalid database CA'); ssl.ca = env.INBOX_REPLY_SEND_DATABASE_CA; }
  }
  return { host: url.hostname, port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database, ssl };
}
async function readBoundedJson(response, limit) {
  if (!response.ok) { try { await response.body?.cancel(); } catch { } throw Error('Durable dispatch rejected'); }
  if (!response.body) throw Error('Missing bounded response');
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); throw Error('Invalid durable dispatch response'); } chunks.push(part.value); } } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export function createRestateReadinessProbe(fetcher, ingress, clock = Date.now) {
  return createReadinessProbe(async () => {
    const response = await fetcher(new URL('/restate/health', ingress), { method: 'GET', signal: AbortSignal.timeout(1500), redirect: 'error' });
    const body = await readBoundedJson(response, 16384);
    return Array.isArray(body?.services) && body.services.length <= 500 && body.services.every(s => typeof s === 'string') && body.services.includes('InboxReplySend');
  }, clock);
}
