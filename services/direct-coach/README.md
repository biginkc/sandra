# Sandra direct coach service

This standalone Node service accepts a Telnyx media WebSocket at `/media` and
publishes approved transcript and coaching-card events to the private
Supabase Realtime channel `coach:<callId>`. It is a single-replica service with
an in-memory two-session admission limit.

The query token is `base64url(JSON claims).base64url(HMAC-SHA256(payload,
DIRECT_COACH_STREAM_SECRET))`. Claims are exactly `callId`, `sellerLegId`, and
`expiresAtMs`; expiry must be in the future and no more than 210 seconds ahead.
The service verifies the token before its fresh database binding read. The
binding query also requires the seller leg, active `connected` or
`seller_dialing` call, exact reviewed immutable script tuple and recomputed
digest, same-org Acquisitions membership, and unexpired active access.

Telnyx's `connected` preamble is accepted and ignored. The first actionable
provider frame must be `start` with the claimed `call_control_id` and
`PCMU`/8000/mono format. Media chunks are globally
reordered with a bounded gap buffer, then routed inbound to the seller bridge
and outbound to the representative bridge. Audio, messages, session duration,
and shutdown waits are bounded. A persistent chunk gap or limit closes the
session. ASR and classifier keys are read only by the server.

Required runtime variables are `DIRECT_COACH_STREAM_SECRET` (at least 32
bytes), `DEEPGRAM_API_KEY`, `COACH_JEV_API_KEY`, and the
matched `SANDRA_COACH_SUPABASE_URL` plus
`SANDRA_COACH_SUPABASE_SERVICE_ROLE_KEY` pair. `PORT` defaults to `9085`.
`GET /healthz` reports only process health and active session count.

`npm test`, `npm run typecheck`, and `npm run build` are local checks. Provider
calls, deployments, and live acceptance are outside this service package.
