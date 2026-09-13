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

Separately, `scripts/rehearse-dialpad-full-schema.mjs` replayed all 248 current
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
