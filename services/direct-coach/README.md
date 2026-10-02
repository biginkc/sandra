# Sandra direct coach service

This standalone Node service accepts a Telnyx media WebSocket at `/media` and
publishes approved transcript and coaching-card events to the private
Supabase Realtime channel `coach:<callId>`. It also owns the always-on
browser-loss watchdog at `/presence`, independent of the coach toggle. It is a
single-replica service with an in-memory two-session media admission limit and
a durable database-clock watchdog sweep.

The query token is `base64url(JSON claims).base64url(HMAC-SHA256(payload,
DIRECT_COACH_STREAM_SECRET))`. Claims are exactly `callId`, `sellerLegId`, and
`expiresAtMs`; expiry must be in the future and no more than 210 seconds ahead.
The service verifies the token before its fresh database binding read. The
binding query also requires the seller leg, active `connected` or
`seller_dialing` call, exact reviewed immutable script tuple and recomputed
digest, same-org Acquisitions membership, and unexpired active access.

The presence token is a separate HMAC capability delivered as the first
WebSocket frame, never in the URL. The request Origin must match the explicit
allowlist. Admission locks the exact direct-call id, browser leg, owner, and
session nonce in Postgres before returning `presence_ack`; application
Native WebSocket pongs renew a twelve-second lease, while abnormal socket loss
receives a five-second reconnect grace. Application heartbeat frames are
acknowledgement-only compatibility messages. A two-second server sweep claims expired leases
and calls the Sandra cleanup endpoint with a fenced, bounded request. Server
shutdown leaves leases intact so a restarted watchdog can recover them.

Telnyx's `connected` preamble is accepted and ignored. The first actionable
provider frame must be `start` with the claimed `call_control_id` and
`PCMU`/8000/mono format. Media chunks are globally
reordered with a bounded gap buffer, then routed inbound to the seller bridge
and outbound to the representative bridge. Audio, messages, session duration,
and shutdown waits are bounded. A persistent chunk gap or limit closes the
session. ASR and classifier keys are read only by the server.

Required runtime variables are `DIRECT_WATCHDOG_TOKEN_SECRET` (or the shared
`DIRECT_WATCHDOG_SECRET`), `DIRECT_WATCHDOG_CLEANUP_URL`,
`DIRECT_WATCHDOG_CLEANUP_SECRET`, and a comma-separated
`DIRECT_WATCHDOG_ALLOWED_ORIGINS`; secrets must be at least 32 bytes. When
`DIRECT_COACH_ENABLED` is not `false`, the service also requires
`DIRECT_COACH_STREAM_SECRET`, `DEEPGRAM_API_KEY`, and `COACH_JEV_API_KEY`. It
always requires the matched `SANDRA_COACH_SUPABASE_URL` plus
`SANDRA_COACH_SUPABASE_SERVICE_ROLE_KEY` pair. `PORT` defaults to `9085`.
`GET /healthz` reports only process health and active session count.

Native WebSocket pong empirically closes within a few seconds after a Chrome
renderer crash and remains healthy during a frozen page, so the watchdog covers
renderer crash and network loss without treating a background timer pause as
loss. It does not claim to detect a frozen main thread. The thirty-second
cleanup target is a healthy-service/provider timing bound; provider outage
requests remain durable and truthful under the normal 180-second call
backstop. Before release, the single process must pass a two-call media plus
watchdog event-loop load check.

`npm test`, `npm run typecheck`, and `npm run build` are local checks. Provider
calls, deployments, and live acceptance are outside this service package.
