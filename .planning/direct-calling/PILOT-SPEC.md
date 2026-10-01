# Direct calling pilot — build spec (orchestrator-owned)

Owner decision (Jarrad, 2026-10-01): the softphone must stop going through Jitter. Morning goal: Jarrad, and only Jarrad, places a call from Sandra's existing softphone straight through Telnyx and checks the audio is clear. Every other user is unchanged.

Scope is deliberately small. **In:** pilot gate, browser registration, server-dialed browser leg, server-dialed seller leg bridged on answer, status, hangup, mute (local), hold (SDK), DTMF (server), wrap-up through the existing path. **Out:** coaching, recording, mid-call recovery, Railway worker, min-build gate, Dialpad, any Jitter deletion. Jitter path stays exactly as is for everyone not in the pilot.

## Call flow

1. Softphone opens (pilot user) → `getDirectRtcToken()` → server ensures the user has a Telnyx telephony credential on the Sandra browser connection (one per user, stored in `direct_call_operators`), mints a JWT, returns `{ token, sipUsername }`. Browser registers with `@telnyx/webrtc` 2.27.1.
2. Rep clicks call → `startDirectCall({ propertyId } | { phone }, clientRequestId)`:
   - authenticates; requires pilot membership;
   - runs the **existing** `prepareLeadCall` / `prepareManualCall` unchanged (DNC, quiet hours, training, enrollment pause — no rule logic is copied or altered);
   - refuses if the user already has a non-terminal direct call;
   - inserts `direct_calls` (status `browser_connecting`, frozen destination + caller ID);
   - Telnyx Dial to `sip:<sipUsername>@sip.telnyx.com` from the caller ID, `client_state` = base64 `{"directCallId","role":"browser"}`, `custom_headers` `X-Sandra-Direct-Call-Id`, `timeout_secs` 30, `time_limit_secs` 7200, `command_id` = a fresh UUID stored on the row;
   - stores the browser leg `call_control_id`; returns `{ directCallId, browserLegId }`.
3. Browser: on incoming invite, auto-answer **only** if `call.telnyxIDs.telnyxCallControlId === browserLegId` OR the `X-Sandra-Direct-Call-Id` header equals the pending `directCallId`. Anything else is rejected, never answered.
4. Webhook `call.answered` for the browser leg → if the row is `browser_connecting` and was created < 60s ago → Dial seller: `to` = frozen destination, `from` = caller ID, `link_to` = browser leg, `bridge_on_answer=true`, `bridge_intent=false`, **no** `park_after_unbridge` (no recovery: browser loss ends the seller leg), `timeout_secs` 30, `time_limit_secs` = 7200 − elapsed, `client_state` role `seller`. Status → `seller_dialing`.
5. `call.answered` seller → status `connected`. `call.bridged` recorded.
6. `call.hangup` on either leg → hang up the other if live; status `ended` (or `failed` if the seller never answered) with `hangup_cause` saved.
7. Browser polls `getDirectCallStatus(directCallId)` every 1s while active.
8. Wrap-up uses the existing `completeSoftphoneCall` **unchanged**, capability-less path: it writes `provider='sandra_softphone'`, `jitter_attempt_id='sandra-<wrapToken>'`. No change to `call_activities`, reconciliation, training checks or recording routes.

## Contract (`src/lib/direct-calling/contract.ts` — both halves build against this)

See the file. Server actions live in `src/lib/direct-calling/actions.ts` (`"use server"`).

## Server pieces (backend PR)

- Migration `supabase/migrations/20261001200000_direct_calls.sql` (+ `supabase/rollbacks/`, + `.integration.test.ts` beside it, following repo conventions):
  - `direct_call_operators(user_id pk, org_id, telnyx_credential_id, sip_username unique, created_at)`.
  - `direct_calls(id uuid pk, org_id, operator_user_id, property_id null, contact_id null, destination_e164, caller_id_e164, status text check in (browser_connecting, seller_dialing, connected, ending, ended, failed), browser_leg_id unique null, seller_leg_id unique null, hangup_cause, failure_reason, client_request_id uuid, created_at, connected_at, ended_at, updated_at)`; unique `(operator_user_id, client_request_id)`; partial unique index one non-terminal call per operator.
  - `direct_call_events(provider_event_id pk, direct_call_id null, event_type, occurred_at, received_at, payload jsonb)`.
  - RLS on all three: authenticated SELECT where org membership (existing membership predicate) AND for `direct_calls` `operator_user_id = auth.uid()`; no authenticated INSERT/UPDATE/DELETE. Writes only from server code via the admin client.
- `src/lib/direct-calling/config.ts`: server-only. `DIRECT_CALL_PILOT_USER_IDS` (comma list), `TELNYX_DIRECT_API_KEY`, `TELNYX_DIRECT_CONNECTION_ID` (browser credential connection), `TELNYX_DIRECT_APP_ID` (Voice API app; used as Dial `connection_id`), `TELNYX_DIRECT_WEBHOOK_PUBLIC_KEY`, `DIRECT_CALL_CALLER_ID_E164`. `resolveCallingConfig(userId)` → `{ transport: "telnyx_direct" | "default" }`; `"telnyx_direct"` only if pilot AND all env present.
- `src/lib/direct-calling/telnyx.ts`: fetch client for `https://api.telnyx.com/v2`, Authorization redacted in all errors/logs, 10s timeout. Dial, hangup, send_dtmf, create telephony credential, create token.
- `src/app/api/webhooks/telnyx/direct-calls/route.ts`: Node runtime; read raw body; verify Ed25519 (`telnyx-signature-ed25519`, `telnyx-timestamp`, 300s tolerance) with `crypto.verify`; insert `direct_call_events` ON CONFLICT DO NOTHING (duplicate → 200, no work); apply the transition; return 200 only after the DB write; DB failure → 500. Unknown/foreign calls (no matching `client_state`/leg) → store and 200, never control them.
- Never re-send a Dial whose result is unknown; if a Dial request times out, mark the call `failed` with `failure_reason='dial_outcome_unknown'` and hang up any leg later seen for that call.

## Browser pieces (frontend PR, stacked on backend)

- `src/lib/dialer/telnyx-direct-transport.ts`: implements `CallTransport` using the contract actions + `@telnyx/webrtc` 2.27.1 (dynamic import, like `jitter-transport.ts`). Maps status → `CallTransportState` (`browser_connecting`→`connecting`, `seller_dialing`→`ringing`, `connected`→`live`, `ended`→`ended`, `failed`→`failed`). `mute` = SDK local mute; `hold` = SDK `hold()`/`unhold()`, treat resolved `false` as failure; `sendDigit` → `controlDirectCall(dtmf)`; `hangup` → `controlDirectCall(hangup)` then SDK hangup; `callHandle()` returns `{ id: directCallId }`; `terminalIsAuthoritative()` true once status is `ended`/`failed`.
- `src/app/(dashboard)/layout.tsx`: resolve `getCallingConfigForCurrentUser()` server-side, pass `callingConfig` prop to `SoftphoneProvider`.
- `softphone-provider.tsx`: when `callingConfig.transport === "telnyx_direct"`: `callingEnabled` true; **no** Jitter caller-ID inventory fetch, **no** `mintJitterStartIntent`, **no** Jitter recovery probe; factory returns `TelnyxDirectCallTransport`; caller-ID UI hidden/replaced by "Sandra direct line". Otherwise behaviour is byte-for-byte unchanged. Wrap-up passes no `callCapability`.
- Tests: transport unit tests with a mocked SDK (reuse `e2e/synthetic/fixtures/telnyx-webrtc-browser-stub.ts` patterns); provider tests proving pilot mode makes zero Jitter action calls and non-pilot mode is unchanged.

## Rules for every agent

- No LLM adds, edits, merges, replaces or removes a business rule (grader questions, Yes/No rules, objection definitions, script checks, rubrics, trained replies, coaching text, eligibility/DNC/quiet-hours rules) without Jarrad's verbatim approval. Call the existing functions; never copy or change their logic.
- Repo is public: no keys, phone numbers, user IDs or tokens committed.
- Read `node_modules/next/dist/docs/` for any Next.js API you use (Next 16.3.5; `AGENTS.md`).
- PRs: draft, `Depends on:` stated, children based on the parent branch. Do not merge, do not request review.
