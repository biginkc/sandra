# Direct calling: decisions

Decisions made by Jarrad on 2026-10-01. Source plan: `PLAN-rev5.4.md`. Phone numbers, keys and tokens are never recorded in this repo; they are supplied at run time through environment variables only.

## Decided

- **D1.** The softphone should no longer go through Jitter at all. The aim is to relieve latency and connectivity problems on the current Telnyx-via-Jitter path.
- **D2.** Go-ahead for the Phase 1 test, **$25 total spend cap**. Limits were proposed by the orchestrator and Jarrad did not object:
  - maximum 60 call attempts
  - 30 s ring limit
  - 180 s maximum leg duration
  - 30 s F7 leg-end deadline
- **D3.** Caller ID is any existing Telnyx number on the account, chosen at run time by the orchestrator; its routing is unchanged. Test phones are Jarrad's mobile (primary) and his Dialpad line (secondary). The numbers are supplied at run time via `DIRECT_CALL_TEST_PHONES` and are not written anywhere in the repo.
- **D4.** No mid-call recovery in the first release. F7 runs. R1 to R3 are skipped and recorded as intentionally skipped.
- **API key.** Jarrad chose (in chat, 2026-10-01) the Telnyx key stored in the team password manager under the "Jitter Dialer" item, read through the service account at run time into the `TELNYX_API_KEY` environment variable of the run process only, never stored. This overrides the plan's "Jitter's own Telnyx keys are not used" line. A leak would force rotating that key, which Jitter also uses; if the key is ever exposed, stop and tell Jarrad immediately.
- **Test far end.** Jarrad confirmed the existing AI responder (the fictional "Jordan" training homeowner run by Switchboard) may be used for test calls instead of a human phone. Its number is supplied at run time, not recorded here. Calls to it create Switchboard administrative records but no lead or customer data.
- **Morning goal.** Jarrad (2026-10-01): have the direct integration working in production for him by morning so he can check the audio. Pilot-only; everyone else unchanged.

## Still open

- **D5.** Recording/transcription consent and retention policy for real contacts. Blocked until decided. Gates any real-contact recording.
- **D6.** Whether direct calls require the lead be assigned to the calling rep. No such rule exists today; a new rule needs Jarrad's exact wording. Not added.
- **D7.** May a second copy of the approved coaching question/rule text exist in Sandra, and which repo is the source of truth? No copy of any rule text is made before this is answered.
- **D8.** Pilot = allowlisted reps; rollback disables new direct starts with no fallback to Jitter. Acceptable only while pilot reps keep another way to call.
