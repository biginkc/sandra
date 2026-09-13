# Maria Dialpad pilot

This is a gated integration under development. No live calling UI is mounted and
the webhook and workers are disabled by default. Passing fixtures is not evidence
that Maria's recording downloads or CTI access work.

## Implemented path

- Dedicated HS256 webhook → durable organization-scoped inbox before acknowledgment.
- Leased event worker → receipt/intent validation in SQL → one activity and acquisition attempt.
- Recording metadata → paced artifact worker → authenticated download → complete FFmpeg decode → private upload/read-back → availability metadata.
- Authenticated playback signs only owned media; multiple segments require explicit selection.
- Dialpad wrap-up references finalize the existing attempt; manual logging remains separate.

The start action is not mounted. It uses server-owned Maria identity, caller ID,
device and lead eligibility. An uncertain start is never retried automatically.
Scoped sequence-pause ownership restores only unchanged enrollments on definite
failure. Ambiguous starts remain reserved pending reconciliation.

## Local verification

```sh
npx vitest run src/lib/dialpad-voice src/app/api/webhooks/dialpad-voice
node --test supabase/migrations/*dialpad*.integration.test.mjs
npm run typecheck
```

The SQL tests start disposable local PostgreSQL clusters with prerequisite fixture
relations. They do not connect to hosted Supabase and do not replace a complete
application migration rehearsal. FFmpeg tests exercise generated WAV media.

Separately, `scripts/rehearse-dialpad-full-schema.mjs` replayed all 250 current
SQL migrations against a fresh genuine local Supabase Auth/Storage database.
The receipt hashes match the current files. This proves clean installation
compatibility, not hosted-schema parity or provider behavior.

## Worker runtime

The server-only environment variables are listed in `.env.example`. An enabled,
properly configured runtime can process one bounded batch with:

```sh
npm run dialpad:voice-events
npm run dialpad:recording
npm run dialpad:recover-starts
```

The recording runtime needs an installed FFmpeg executable. These commands are
not scheduled or deployed by this change. The recording claim reserves at least
seven seconds between Call Get requests for this organization's worker and backs
off on 429. Other consumers of the same provider allowance need coordinated pacing.
The configured recording bucket must already exist and remain private.

Predispatch recovery is separately disabled by default and processes only old
reservations proven undispatched under an atomic lock. It never retries a call
or releases an ambiguous dispatch. Apply the complete pilot migration set before
enabling any runtime; the commands are not a deployment or scheduling mechanism.

Softphone starts reserve transport ownership before pausing sequences. Provider
terminal evidence, not browser wrap-up time, releases that ownership. Batch
claims and active Dialpad intents mutually exclude each other at organization
scope because batch records lack a verified active operator. This limits pilot
concurrency. Drain existing calls/claims before activation and verify that the
external batch worker checks current fencing before dialing; cached claim replies
are not fresh dispatch authorization. Conflicting late call evidence stays in
the durable inbox for reconciliation rather than silently bypassing exclusion.

## Unclosed acceptance gates

- Actual unattended Maria recording download. Tested historical admin URLs returned login HTML; no provider audio has been retained yet.
- CTI registration submission/provisioning and Maria identity inside the embedded client.
- Actual caller ID/device selection, exact-call controls and a controlled live functional call.
- Hosted-schema parity and hosted event/storage proof; worker scheduling and provisioning.
- Missed-event and ambiguous-dispatch reconciliation, live transcript/summary ingestion proof, and supported live Coach parity. Post-call ingestion and undispatched crash recovery are implemented locally.
- Measured talk-duration semantics. Provider connected duration is stored separately; unknown talk duration stays null.
- Complete browser workflow verification and release review. Mel and long-call/drop testing remain deferred.

No public recording-sharing workaround or browser-session credentials are used.

## Bound-call REST reconciliation (disabled)

`npm run dialpad:reconcile-bound` refuses to run unless
`DIALPAD_BOUND_RECONCILIATION_ENABLED=true`. It uses the existing server database
credentials and `DIALPAD_VOICE_API_KEY`. No scheduler is installed.

This pilot is restricted in SQL to Maria's already provider-bound activities in
BMH's organization. Each invocation seeds at most 100 existing-call jobs and
claims at most one. Call Get shares the recording worker's seven-second database
budget; HTTP 429 extends that shared budget by 60 seconds. Successful snapshots
become due after 15 minutes; provider-terminal calls pause after a 24-hour
enrichment window. Active calls never age out. Eight consecutive processing
failures stop automatic retry. Paused, failed, and quarantined jobs require
operator investigation; none establishes recording completeness.

REST snapshots retain their original payload and explicit provenance separately
from signed webhook receipts. SQL verifies the persisted call, intent, rep,
organization, numbers, and start timestamp before enriching the existing call.
It never creates acquisition credit or manufactures `custom_data`. Discovered
recording segments enter the existing recording jobs without overwriting owned
copies. The recording completeness gate still requires a qualifying manifest.

CLI `acknowledgedReceipts` counts receipts whose lease-protected processing was acknowledged,
including quarantined receipts; it is **not a successful-tracking count**. Inspect
job status and error code to determine the result. `failed` counts acknowledged
error handling, including retries, and `leaseLost` counts rejected ownership.
This closes a local implementation gap for bound calls only: unbound or ambiguous
starts, hosted scheduling, late data after the polling window, authenticated
recording downloads, and end-to-end parity remain separate acceptance gates.


The unmounted `hangupMariaDialpadCall` server action is separately gated by
`DIALPAD_VOICE_HANGUP_ENABLED`. It accepts only an intent ID, requires the active
pilot rep and matching persisted call activity, and sends exact-call hangup.
It never releases transport ownership or treats request acceptance as terminal
evidence. Unbound starts still cannot be controlled through this action. No live
hangup has been validated.
