# Direct-calling feasibility harness (Phase 1)

Tests whether Telnyx can do what the direct-calling plan needs (server dials the browser, then the seller, then bridges). Spec: `.planning/direct-calling/PLAN-rev5.4.md` (Phase 1 "Safety envelope" and "Questions"). Decisions: `.planning/direct-calling/DECISIONS.md`. Results go in `.planning/direct-calling/FEASIBILITY.md`.

Not imported by the app. Plain TypeScript run with `tsx`, Node built-ins only (the stream receiver is a small hand-written WebSocket parser, so no dependency was added). The browser page loads `@telnyx/webrtc@2.27.1` from unpkg.

**Everything is dry-run unless you pass `--live` and type the confirmation phrase.** Dry-run makes no network calls at all (not even reads). Run state (inventory, event log, budget, results) lives in the gitignored `scripts/direct-call-feasibility/.run/`.

## Environment (supplied at run time, never stored)

| Variable | Meaning |
|---|---|
| `TELNYX_API_KEY` | The API key. Held only in this process's environment. Never write it to a file, tunnel config or the browser page. |
| `DIRECT_CALL_TEST_PHONES` | Comma list of owned test phones, E.164 |
| `DIRECT_CALL_CALLER_ID` | One existing Telnyx number on the account, E.164 |
| `DIRECT_CALL_PUBLIC_BASE_URL` | `https://` origin of the separately started tunnel |
| `TELNYX_PUBLIC_KEY` | Telnyx webhook public key (base64) for signature checks |
| `DIRECT_CALL_DEV_SIP_ENDPOINTS` | Optional, developer-owned external SIP endpoints for F2 |
| `DIRECT_CALL_MAX_ATTEMPTS` etc. | Optional; can only tighten the approved limits (60 attempts, $25, 30 s ring, 180 s leg, 30 s F7 deadline) |

Inject the key into the run process only (for example from your secret manager in the same command line); do not export it into your shell profile. The harness never spawns child processes; if one is ever added it must use `childEnv()` in `run.ts`, which strips `TELNYX_API_KEY` and `OP_SERVICE_ACCOUNT_TOKEN`.

**The tunnel must be the only ingress.** Point it at `localhost:8787` and expose nothing else; do not port-forward, bind other interfaces or add a second proxy. The server binds loopback only and treats any request carrying forwarded headers or a non-local Host as tunnelled (404 for everything but the signed `/webhook` and the token-guarded `/stream/<token>`).

## Run order

Run from the repo root: `npx tsx scripts/direct-call-feasibility/run.ts <command> [--live]`

1. Start the tunnel yourself, pointing at `localhost:8787`. Do not start it from the harness (it must not inherit the key).
2. `preflight` : read-only. Lists numbers/connections/apps/profiles, confirms the caller ID is on the account (stops if not), saves the snapshot.
3. `setup` : creates the isolated resources (credential connection with `sip_uri_calling_preference=internal`; Voice API app; a disabled profile on the connection; an enabled capped profile on the app; two test credentials). Reads cap, limit and attachments back and refuses to proceed on any mismatch.
4. `f1` to `f7` (one at a time, operator present, outside rep calling hours). Each starts the local server on `http://localhost:8787`; open that page in a browser for the test. R1 to R3 are not implemented: skipped per D4.
5. `teardown` : stop attempts, list legs on test connection and app, re-check each leg's connection/app ID is inventoried, hang up, confirm ended by provider evidence, then delete credentials, connection, app, profiles, recordings, then list remaining and diff against the preflight snapshot. The API key is untouched. Close the tunnel afterwards.

Run `teardown` after any failure or stop condition too.

## Safety rules (from the plan)

- Only new, clearly named test resources. Existing Jitter and Dialpad connections, apps, profiles, numbers and messaging are read-only.
- Create, list and read are allowed. Update, delete and call-control only against IDs in the inventory; the client refuses anything else in code before any network call.
- Dial targets are only: `DIRECT_CALL_TEST_PHONES`, a test credential SIP username on the test connection, or a developer-owned SIP endpoint. Every Dial sets `time_limit_secs` (max leg duration) and a ring `timeout_secs`. Dial only from the configured caller ID. No real prospects or leads.
- One test call at a time. A limit-style rejection is recorded as inconclusive and reported, not worked around. An uncertain Dial outcome is reconciled by lookup, never re-sent.
- F2: each escape probe runs only after a provider-side duration bound at or below the max leg duration is shown. Untested probe = F2 not passed.
- Readiness: `setup` persists a readiness flag only after the read-only read-back of cap, limit, enabled flags and attachments succeeds. Every live flow and every browser token issuance re-reads those settings (GETs only) and refuses if setup never passed or anything changed.
- F2 probe buttons stay disabled until the F2 flow arms the local server for the current run (after the containment bound is shown). Each probe starts via the server, which reserves an attempt and estimated spend, allows one outstanding probe at a time, and logs `escape.probe.*` events.
- Media stream: the stream URL carries a run-scoped random token (`/stream/<token>`); other paths/tokens are dropped, and frame/buffer sizes are capped.
- Teardown deletes a recording only if its call_control_id / call_leg_id / call_session_id matches a call recorded in the inventory; anything ambiguous is skipped and logged (`teardown.recording.skipped`).
- The browser page plays remote audio through an `<audio autoplay>` element and shows WebRTC inbound/outbound audio byte counts and audioLevel (also logged as `audio.stats`) as F1 two-way-audio evidence.
- The webhook server verifies the Ed25519 signature (5-minute tolerance) and dedupes on event id. The page, token and config are served to localhost only.
- Spend: the harness counts attempts and an ESTIMATED spend (configurable per-minute figure, reserved per Dial at full leg duration) and refuses past 60 attempts or $25. This is an estimate; the provider-side daily cap on the enabled profile is a backstop, and live legs are ended by `time_limit_secs`.
- Recording only with the consenting owned test participants; test recordings are deleted at teardown.

## Stop conditions

Stop immediately, run `teardown`, and report to Jarrad if: a call reaches any number not in `DIRECT_CALL_TEST_PHONES`; any existing Telnyx resource changes; the spend cap is hit; anything could affect live Jitter or Dialpad calling; or the API key may have been exposed (tell Jarrad immediately). If Telnyx rejects the caller ID as not assigned to the test application, stop and ask; do not reassign it.

## Tests

`npx vitest run scripts/direct-call-feasibility` (mocked fetch, zero network). They are also picked up by `npm test` via `vitest.config.ts`.
