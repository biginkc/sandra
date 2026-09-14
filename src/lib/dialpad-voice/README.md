# Acquisitions Dialpad desktop integration

This draft is disabled by default. Dialpad desktop owns call audio and native controls; Sandra owns verified number selection, guarded API initiation, immutable lead/rep attribution, wrap-up, reporting, and private artifacts. The older Maria-only start, bound reconciliation, and CTI code remain gated legacy paths and are not the acquisitions workflow. Do not enable them as a substitute for this design.

## Current flow

1. An owner assigns a Dialpad user and exact authorized personas/numbers to an active acquisitions member. Rep options come from that member's grants intersected with fresh Dialpad Persona List inventory. Shared numbers with distinct office, department, call-center, or user identities stay distinct.
2. The rep selects a caller identity and a verified native desktop registration in Sandra. The configured start action freezes the organization, rep, assignment episode, lead, connection, binding, grant, verification, device, and selected number in one intent. Eligibility and revisions are rechecked at dispatch. A provider response is only a candidate; uncertain requests are not automatically retried or credited.
3. A signed webhook is persisted before acknowledgement with an immutable source ID. The worker accepts only exact company, organization, rep, call, and configured intent matches. Source rotation uses `DIALPAD_VOICE_WEBHOOK_SOURCE_ID` and up to three comma-separated `DIALPAD_VOICE_WEBHOOK_PREVIOUS_SOURCE_IDS`. Each source has its own secret reference. A persistence error never triggers verification against another source.
4. Terminal events and bounded Call Get reconciliation enrich the original call activity and acquisition attempt. Historical credentials resolve from the frozen connection revision, even after current grants are revoked. Receipt and artifact processing use leased jobs with database-time expiry fences.
5. Recording jobs verify the original call and recording segment against the frozen intent, download through the bounded authenticated Dialpad redirect chain, decode with FFmpeg, and retain owned files in private storage. The recording completeness KPI requires a processed same-company source manifest and every private retained segment. Playback signs only authenticated, authorized artifacts. Transcripts and summaries are post-call evidence, not a live Coach feed.

The command-line workers are one-batch entry points, not schedulers or deployment. See `.env.example` for gates and runtime variables. They require the complete migration chain, private Storage bucket, service credentials, and an installed FFmpeg executable:

```sh
npm run dialpad:voice-events
npm run dialpad:recording
npm run dialpad:recover-starts
```

Keep the older Maria-only CLI/CTI flags disabled. Do not change hosted acquisitions membership, source subscriptions, worker scheduling, or production activation based on local fixtures alone.

## Evidence as of 2026-09-14

- Clean genuine local Supabase replay passed 264 migrations, followed by seven full-schema behavior checks using frozen configuration. Focused PostgreSQL tests cover webhook source provenance/rotation, tenant separation, revocation, dispatch contention, and event/recording lease expiry.
- A two-rep local test passed the actual signed receiver -> PostgREST inbox -> event worker -> SQL path. It rejected a wrong signature, deduplicated a signed event, quarantined a wrong-rep target, retained connected duration, and finalized exactly one original-rep acquisition attempt. Provider events in that test were synthetic.
- Full local verification passed 4,673 unit tests, 1,413 UI tests, typecheck, and required e-sign checks. All 82 synthetic browser tests passed. These are code and fixture proofs, not a completed live call.
- One real manual recording was downloaded and fully decoded, then retained and read back byte-identically through private local Storage. This does not prove automatic admin recording coverage or every segment.
- Two authorized owned-number capability call attempts have been consumed. The second received HTTP 200 and reached the selected native desktop registration, then ended with `native_call_error` before connection. No connected audio was demonstrated. Do not place another real call without new authorization.

## Release gates still open

Connected desktop audio; unattended access to all required automatic recordings and segments; audible Sandra playback; measured **seller** speaking seconds and five-minute boundaries separate from connected duration; a supported during-call audio/transcript source for live Coach; supervised hosted workers and webhook delivery; complete multi-member live workflow, including notes/appointments/offers/sequences and Central-time KPIs; and exact-head CI/browser review. Dialpad's `call_transcription` event indicates a transcript is ready after processing. It does not establish a during-call stream. Unknown speech measurements stay unknown; connected duration must not be relabeled as seller speech.

Calls started outside Sandra have no prepared lead/episode intent. Do not infer acquisition credit from a number match. Any later unresolved-call matching workflow must require explicit, authorized attribution.
