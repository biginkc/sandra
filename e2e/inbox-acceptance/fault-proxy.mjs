import http from 'node:http';
import net from 'node:net';

// Test-only loopback bridge. The runner owns 54321 (API) and 54322 (DB),
// forwarding to the already-running owned Supabase stack on 55421/55422.
// The app's disposable-target guard requires the 54321/54322 endpoints.
const token = process.env.OUTBOX_FAULT_TOKEN;
if (!token || process.env.E2E_DISPOSABLE_DATABASE !== '1' || process.env.MESSAGING_PROVIDER !== 'mock') {
  throw new Error('Outbox fault proxy requires disposable mode, mock provider, and token');
}

let armed = false;
let failures = 0;
const api = http.createServer((request, response) => {
  if (request.url?.startsWith('/__outbox_fault/')) {
    if (request.headers['x-outbox-fault-token'] !== token) {
      response.writeHead(403).end();
      return;
    }
    if (request.url === '/__outbox_fault/arm' && request.method === 'POST') {
      armed = true;
      failures = 0;
      response.writeHead(204).end();
      return;
    }
    if (request.url === '/__outbox_fault/disarm' && request.method === 'POST') {
      armed = false;
      response.writeHead(204).end();
      return;
    }
    if (request.url === '/__outbox_fault/status' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ armed, failures }));
      return;
    }
    response.writeHead(404).end();
    return;
  }

  const url = new URL(request.url ?? '/', 'http://127.0.0.1:54321');
  const isQueueRead = request.method === 'GET' && url.pathname === '/rest/v1/messages' &&
    url.searchParams.get('status') === 'eq.queued' &&
    (url.searchParams.get('select') ?? '').includes('property:properties');
  if (armed && isQueueRead) {
    failures += 1;
    response.writeHead(503, { 'content-type': 'application/json' })
      .end(JSON.stringify({ code: 'P0_TEST_FAULT', message: 'Outbox queue read failure while armed' }));
    return;
  }
  const upstream = http.request({
    hostname: '127.0.0.1', port: 55421, path: request.url, method: request.method,
    headers: { ...request.headers, host: '127.0.0.1:55421' },
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on('error', error => {
    if (!response.headersSent) response.writeHead(502);
    response.end(error.message);
  });
  request.pipe(upstream);
});

const db = net.createServer(socket => {
  const upstream = net.connect(55422, '127.0.0.1');
  socket.pipe(upstream).pipe(socket);
  socket.on('error', () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
});

await Promise.all([
  new Promise((resolve, reject) => api.listen(54321, '127.0.0.1', resolve).once('error', reject)),
  new Promise((resolve, reject) => db.listen(54322, '127.0.0.1', resolve).once('error', reject)),
]);
console.log('Outbox disposable fault proxy: API 54321 -> 55421, DB 54322 -> 55422');
function close() { api.close(); db.close(); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
