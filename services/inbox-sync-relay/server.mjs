import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const columns = 'org_id,target_kind,target_id,name,context,preview,time_label,outcome_label,assigned_label,unread';
const responseHeaders = ['content-type','electric-handle','electric-offset','electric-schema','electric-cursor','electric-up-to-date'];
const allowedQuery = new Set(['offset','handle','live','cursor','log','table','columns','replica','where']);
const digest = value => createHash('sha256').update(value).digest();
/** A server-to-server boundary. Browser authorization stays in the Next gateway. */
export function createRelayServer({ upstream, token, projectionTable, transport = fetch, maxConcurrent = 32 }) {
  const target = new URL(upstream);
  if (!['http:','https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash || target.pathname !== '/') throw Error('Invalid relay upstream');
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /\s/.test(token)) throw Error('Relay token must be a nonempty high-entropy secret');
  if (!/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/.test(projectionTable)) throw Error('Invalid projection table');
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) throw Error("Invalid relay concurrency");
  let active = 0, healthProbe, healthResult;
  async function health() {
    if (healthResult && healthResult.until > Date.now()) return healthResult.status;
    if (!healthProbe) healthProbe = Promise.resolve().then(async () => {
      try {
        const response = await transport(new URL('/v1/health',target), { signal: AbortSignal.timeout(3000), redirect:'error' });
        await response.body?.cancel();
        const status = response.status === 200 ? 200 : 503;
        healthResult = {status,until:Date.now()+1000}; return status;
      } catch { healthResult = {status:503,until:Date.now()+1000}; return 503; }
    }).finally(() => { healthProbe = undefined; });
    return healthProbe;
  }
  const expected = digest(`Bearer ${token}`);
  return createServer({ maxHeaderSize: 8192, requestTimeout: 17000, headersTimeout: 10000 }, async (req,res) => {
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const headers = { 'cache-control':'private, no-store' };
    const finish = (status, body = '') => { if (!res.destroyed) { res.writeHead(status, headers); res.end(body); } };
    let url;
    try { url = new URL(req.url, 'http://relay.invalid'); } catch { finish(400); return; }
    if (req.method === 'GET' && url.pathname === '/health' && !url.search) { finish(await health()); return; }
    if (active >= maxConcurrent) { finish(503); return; }
    active++;
    try {
      if (req.method !== 'GET') { finish(405); return; }
      if (url.pathname !== '/v1/shape' || Buffer.byteLength(req.url) > 8192) { finish(404); return; }
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''),expected)) { finish(401); return; }
      for (const key of url.searchParams.keys()) {
        if ((!allowedQuery.has(key) && !/^params\[[1-9][0-9]{0,2}\]$/.test(key)) || url.searchParams.getAll(key).length !== 1) { finish(400); return; }
      }
      if (url.searchParams.get('table') !== projectionTable || url.searchParams.get('columns') !== columns || url.searchParams.get('replica') !== 'default') { finish(400); return; }
      const endpoint = new URL('/v1/shape',target); endpoint.search = url.search;
      const response = await transport(endpoint, { signal: AbortSignal.any([controller.signal,AbortSignal.timeout(14000)]), redirect:'error', cache:'no-store' });
      const chunks = []; let bytes = 0;
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2_000_000) { await reader.cancel(); finish(413); return; }
            chunks.push(Buffer.from(chunk.value));
          }
        } finally { reader.releaseLock(); }
      }
      if (controller.signal.aborted || res.destroyed) return;
      for (const name of responseHeaders) { const value = response.headers.get(name); if (value !== null) headers[name] = value; }
      res.writeHead(response.status,headers); res.end(Buffer.concat(chunks));
    } catch { finish(502); } finally { active--; }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const upstream = new URL(process.env.INBOX_RELAY_UPSTREAM ?? '');
  // Public Railway ingress terminates TLS. Electric remains private to this project.
  if (!upstream.hostname.endsWith('.railway.internal')) throw Error('Production relay requires private Railway upstream');
  const server = createRelayServer({ upstream:upstream.href, token:process.env.INBOX_RELAY_TOKEN, projectionTable:process.env.INBOX_RELAY_PROJECTION_TABLE });
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
  server.listen(port,'::');
  process.once('SIGTERM', () => { server.close(); setTimeout(() => server.closeAllConnections(),15000).unref(); });
}
