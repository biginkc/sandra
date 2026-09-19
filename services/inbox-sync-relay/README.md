# Inbox sync relay

A dependency-free Node22 server connecting the authenticated Vercel gateway to
private Electric on Railway. This is server-to-server authentication, not a
replacement for current per-user/session/org/workset authorization in Next.

Run unit checks with `node --test services/inbox-sync-relay/server.test.mjs`.
The server starts only with INBOX_RELAY_TOKEN (32–256 non-whitespace characters),
INBOX_RELAY_PROJECTION_TABLE and an INBOX_RELAY_UPSTREAM on Railway private DNS.
Generate a random secret; length validation cannot prove entropy. PORT defaults
to3000. The fixed Dockerfile runs as node and adds no package dependencies.

GET /v1/shape requires the Bearer token and exact projection table/columns. It
forwards only allowlisted Electric query parameters and response headers, never
browser credentials.32 concurrent requests and2MB each bound buffering; overload
returns503. No automatic retries. GET /health is public and checks actual upstream
readiness with a three-second deadline, coalesced outside shape admission and cached for one second. Deployment must keep Electric private and
terminate public relay TLS at Railway. Secret rotation and final Next header wiring
are required before activation; no credentials live in this directory.

Node test groups cover auth/header stripping, unsupported input/methods,
readiness/oversized responses/errors and simultaneous request admission.
`runtime-proof.py` creates uniquely owned synthetic T1 rows and a constrained
nonroot/read-only relay container, checks the actual pinned Electric shape, then
removes exactly its container/table. Do not run it without coordinating T1 fixture
mutation ownership. The runtime receipt binds current source and Dockerfile and
records Node22.23.2. `verify.py` checks only that receipt and performs no network call.

Hosting resource estimates and unresolved rollout dependencies are in
[the deployment candidate](../../deployment/inbox/README.md).
