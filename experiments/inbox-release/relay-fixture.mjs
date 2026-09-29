// Disposable release fixture launcher for the reviewed sync relay.
//
// The production entry point intentionally accepts only a private Railway
// Electric hostname.  The local release fixture is a different transport
// boundary: it runs on the marked host-only stack and connects to the pinned
// Electric container through loopback.  Keep this adapter here so that local
// tests do not weaken the production launcher or silently become deployable
// production configuration.
import { createRelayServer } from '../../services/inbox-sync-relay/server.mjs';

if (process.env.INBOX_RELEASE_HTTP_FIXTURE !== '1') {
  throw Error('Release HTTP fixture mode is required');
}
if (process.env.INBOX_RELEASE_FIXTURE_MARKER !== 'sandra-inbox-release-http-owned-20260917') {
  throw Error('Release HTTP fixture marker mismatch');
}
if (process.env.INBOX_RELAY_PROJECTION_TABLE !== 'inbox_bridge.summaries') {
  throw Error('Release relay must expose the narrow summaries relation');
}

const upstream = new URL(process.env.INBOX_RELAY_UPSTREAM ?? '');
if (upstream.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'electric'].includes(upstream.hostname) || upstream.pathname !== '/') {
  throw Error('Release fixture relay requires the owned Electric upstream');
}
const port = Number(process.env.PORT ?? 58787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid relay port');
const bind = process.env.INBOX_RELAY_BIND ?? '0.0.0.0';
if (!['0.0.0.0', '127.0.0.1'].includes(bind)) throw Error('Invalid relay bind');

const server = createRelayServer({
  upstream: upstream.href,
  token: process.env.INBOX_RELAY_TOKEN,
  projectionTable: process.env.INBOX_RELAY_PROJECTION_TABLE,
});
server.listen(port, bind);
process.once('SIGTERM', () => {
  server.close();
  setTimeout(() => server.closeAllConnections(), 15_000).unref();
});
