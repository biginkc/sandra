# Sandra direct calling separation — revision 5.4 (plan only)

Status: **revision 5.4 — pending re-review by both.** Revision 5.3 was approved by Fable and by Codex Astra with 0 blockers. 5.4 changes: existing API key instead of a new one (Jarrad's decision), recorded decisions, Fable's four clarifications on escape probes, corrected uniqueness fact, and a connect-time/drop measurement. Fable approved 5.1 on its third pass. Codex Astra (medium) then returned `APPROVE_PLAN: NO, BLOCKING: 5` on 5.1, all in the Phase 1 test design; 5.2 addresses them, so the earlier Fable approval no longer applies to this text.

Limits of verification: SDK behaviour comes from the npm package source, not a running test; PR status is as of 2026-10-01; "never run in production" for the worker role file is what the file says, not proven.

Test notes: if R2 (recovery only) fails with a concurrency-limit rejection, record it as a limit artefact and ask Jarrad before raising the limit. For F7, record the measured time to leg end for each loss type whether or not it meets the deadline; a miss on killed tab or network cut is a real finding about the no-recovery design, not a test artefact.

**What approval of this document covers:** Phase 0 and Phase 1 only. Phase 2 and the PR sequence are a **provisional outline, not approved and not implementable**. No code, migration, provider call, spend or deployment is authorized by this document; each phase needs Jarrad's go-ahead.

**Revision 4 is retired.** Nobody implements from it. It was approved without the repos being opened and had 15 factual errors. Nothing here is carried forward by reference: any rule from revision 4 that survives must be written out in full in revision 6 (written after Phase 1) and reviewed there.

## Context

Goal: one-click direct calls from Sandra, with live coaching and recording, that do not depend on Jitter at runtime. Jitter stays for future calling lists and historical playback.

An adversarial check against Sandra `origin/main` 396f770a, Jitter `origin/main` 287a1b36, Telnyx's docs and the `@telnyx/webrtc` 2.27.1 package found the topology (server dials the browser, then the seller, then bridges) is a documented Telnyx pattern, but several load-bearing behaviours are undocumented and the repo facts in revision 4 were wrong. This revision fixes the facts and tests the provider before designing on top of it.

Sandra already has two calling paths on main: the Jitter softphone and Dialpad CTI (`src/lib/dialpad-cti`). This would be a third.

## Decisions recorded (Jarrad, 2026-10-01)

- **D1:** the softphone should not go through Jitter at all; the aim is to relieve latency and connectivity problems on the current path.
- **D2:** go-ahead for the Phase 1 test with a **$25** total spend cap. Still needed: maximum call attempts, ring limit, leg-duration limit, F7 deadline.
- **API key:** use Sandra's existing key (see envelope).
- **Still open:** D3 (caller ID and test phones), D4, and the remaining D2 numbers. Phase 1 does not start until they are given.

## Decisions that belong to Jarrad (none are assumed)

| # | Decision | Recommendation | Gates |
|---|---|---|---|
| D1 | What failure does this fix that neither the Jitter softphone nor Dialpad can fix? | Must be answered in writing. If the answer is only "Jitter is parked", note that gate concerns list dialling. | **Phase 1 spend** and everything after |
| D2 | Authorize the Phase 1 live Telnyx test inside the envelope below. | Yes, once D1 is answered. | Phase 1 |
| D3 | Which single owned caller ID the test dials from, and the test phones. | — | Phase 1 |
| D4 | First release with or without mid-call recovery. Without: if the browser drops, the call ends. | ⭐ Without. It removes the riskiest unproven Telnyx behaviour, generations and fencing. Add recovery later if dropped calls prove common. | **Phase 1** (decides which tests run) |
| D5 | Recording/transcription consent and retention policy for real contacts. | Blocked until decided. Jitter `FOUNDATION.md:55-60` holds an earlier unbuilt posture; context only. | Any real-contact recording |
| D6 | Whether direct calls require the lead be assigned to the calling rep. | No such rule exists today (org membership only). A new rule needs Jarrad's exact wording. Not added. | Revision 6 |
| D7 | May a second copy of the approved coaching question/rule text exist in Sandra, and which repo is the source of truth? | No copy of any rule text is made before this is answered. | Coaching work |
| D8 | Pilot = allowlisted reps; rollback disables new direct starts with no fallback to Jitter. | Acceptable only while pilot reps keep another way to call. | Pilot |

## Verified facts revision 6 must respect

1. `call_activities.jitter_attempt_id` is `text not null` (`supabase/migrations/058_dialer_and_call_activity.sql:82`). Uniqueness today is `(org_id, provider, jitter_session_id, jitter_attempt_id)` (`20260823010000_jitter_call_artifact_writeback_hardening.sql:40`), plus a softphone-only partial index (`20260825010000_jitter_softphone_artifact_writeback_match.sql:34`) and Dialpad's own; the earlier three-column index was dropped.
2. `GET /api/leads/calls/[callActivityId]/recording-url` returns 409 for any provider but `jitter`/`sandra_softphone` and requires Jitter attempt + session IDs (`route.ts:72-98`).
3. No transport identifier enum; selection is one build-time env var (`src/lib/dialer/transport-selection.ts:8-20`). `SimulatedCallTransport` exists (`transport.ts:82`). No "legacy" transport. Dialpad is out of scope and untouched.
4. No general per-user gate for direct calling and no minimum-client-build check exist. (A per-user gate exists only for training calls: `src/lib/dialer/homeowner-training.ts:10`.)
5. No assigned-rep check in `prepareLeadCall` (`src/lib/dialer/actions.ts:87`) or `prepareManualCall` (`:148`).
6. No LISTEN/NOTIFY worker queue in Sandra; workers poll. (`notify` appears only for schema reloads, e.g. `20260909000000_global_search.sql:120`.)
7. Telnyx does not define track naming on an outbound Dial leg or single-leg dual-channel mapping.
8. Telnyx streams the call's codec unless `stream_codec` is set, and falls back to it when transcoding is unavailable. Jitter observed PCMU on its PSTN legs and that a requested override did not take (`src/coach/env.ts:15-23`) — one observation, not a guarantee. The actual stream format must be validated.
9. Telnyx docs: new credentials/JWTs can fail for about 5 seconds; JWT lifetime is 24h or credential expiry. *(Docs only; not independently re-verified.)*
10. SDK 2.27.1 source: `hold()` resolves `false` on failure rather than rejecting; no `call.customHeaders`, values sit under `call.options`, IDs under `call.telnyxIDs`. *(From the npm package; re-confirm in Phase 1.)*
11. `time_limit_secs` range is 30–14400.
12. Historical playback and the recording library call Jitter (`src/lib/recordings/data.ts:62-82`); that dependency stays.

## Phase 0 — clear the ground (no new behaviour)

- Record D1 (and any other decisions made) in `.planning/direct-calling/DECISIONS.md`, in a fresh worktree off current `main`.
- Softphone PRs #522 (`softphone-provider.tsx`) and #492 (`jitter-transport.ts`): owners land or close them before revision 6 is written. #580 (Dialpad) and #519 (coach pre-call) are rebase hazards; nothing is built on their unmerged code.
- Phase 0 touches no application code.

## Phase 1 — live Telnyx feasibility test (needs D1, D2, D3, D4)

### Safety envelope (all mandatory)

- **Isolation.** New, clearly named test resources only: one credential connection, one Voice API application, and **two** new outbound voice profiles — a *disabled* one attached to the browser credential connection, and an *enabled* one with its own small daily spend cap and concurrent-call limit attached to the Voice API application (figures set by Jarrad in D2). Attachments are recorded in the inventory, and all Phase 1 tests run with this configuration unchanged; nothing is toggled between tests. Existing Telnyx resources — Jitter's connections, applications, profiles, numbers, messaging — are **read-only: not modified, not reassigned, not deleted**. The existing shared outbound profile is not used.
- **Hard limits.** D2 sets numbers for: total test spend, total call attempts, maximum ring time, maximum leg duration, and the F7 leg-end deadline. Every leg the script dials — browser, seller, replacement — carries a provider-side `time_limit_secs` at that maximum and a ring timeout, so no leg can outlive the test even if the script dies. The daily spend cap only blocks new calls; it is not relied on to end live ones.
- **Browser-originated legs.** F2 deliberately has the browser try to place calls and transfers; if the restriction fails, those legs exist without the script having dialed them. They are test-owned: any leg on the test connection or test application, found by listing active calls on those two resources, is added to the inventory and may be hung up by the script. Legs on any other connection or application are never controlled. Before each escape probe, a provider-side duration bound for a leg that might result must be shown to exist (for example a limit on the test connection or profile, confirmed by reading the setting back). The bound must be at or below D2's maximum leg duration; Telnyx's four-hour default does not count. If no such bound can be shown, that probe is **not run** and is reported as untested — and an untested probe means F2 is **not passed**: the result goes to Jarrad and the design does not proceed on unproven containment. Independently, every escape target is developer-owned and hangs up on its own, and the browser page hangs up its own call. Before hanging up any discovered leg, the script re-checks that the leg's connection or application ID equals an inventoried test ID. Record which method actually ended each leg.
- **Failure cleanup.** On any failure or stop condition: stop new attempts; list every leg on the test connection and test application, including ones the browser originated; hang up each one; confirm by provider evidence that each has ended; only then delete resources. An uncertain Dial outcome is reconciled by lookup, never re-sent. Deleting a credential is never treated as ending a call.
- **API key.** Treat the key as account-wide (Telnyx documents no per-resource scoping; this is the conservative assumption). By Jarrad's decision (2026-10-01) the test uses Sandra's **existing** Telnyx API key, read from where it is already stored; no new key is created and none is revoked at teardown. Because this is the live key, a leak would force a rotation that interrupts the app's Telnyx features, so: the script holds it only in an environment variable for the life of the process; it is never written to any file, tunnel config or browser page (the browser gets only a short-lived test credential token), and request logging redacts the Authorization header. If the key is ever exposed, stop and tell Jarrad immediately. Jitter's own Telnyx keys are not used. it is never committed, logged or pasted into chat. The script may send create requests, and may send update, delete and call-control requests **only** against IDs recorded in the inventory (resources it created, plus legs found on the test connection or test application); it refuses any other ID in code. List and read requests are unrestricted.
- **Who does what.** The script sets the spend cap and call limit on the enabled test profile through the API and reads them back before the first call; if they do not read back as set, nothing is dialed. Anything that can only be done in the Telnyx portal is Jarrad's; an agent does not attempt it.
- **Numbers and targets.** Dial from the one caller ID named in D3. PSTN and transfer attempts target only the owned test phones named in D3. On-account SIP attempts (F2) target only a second credential on the test connection. External SIP attempts target only an endpoint the developer owns. No Jitter or Dialpad SIP username or number is ever a target. No real prospects or leads. The caller ID's existing routing and assignment are not changed; if Telnyx rejects the caller ID because it is not assigned to the test application, stop and ask Jarrad rather than reassign it.
- **Endpoints.** Webhook URL and stream WebSocket URL are a dedicated temporary tunnel to the developer machine. Never a Sandra, Jitter or other production or preview host. The webhook endpoint verifies the Telnyx signature and the tunnel is closed at teardown.
- **Code.** A script in `scripts/direct-call-feasibility/` and a bare local HTML page using `@telnyx/webrtc` 2.27.1. Nothing imported by the app, no migration, no Sandra database writes, no Vercel or Railway deploy.
- **Recording.** Only the consenting owned test participants. Test recordings are deleted at teardown.
- **Stop conditions.** Stop immediately and report if: a call reaches any number not in D3, any existing Telnyx resource changes, the spend cap is hit, or anything behaves in a way that could affect live Jitter or Dialpad calling.
- **Teardown.** Keep an inventory (resource type + Telnyx ID, no secrets) in `FEASIBILITY.md` as resources are created. At the end the script deletes every test credential, the connection, application, both profiles and the recordings, then lists remaining resources to confirm only pre-existing ones are left. The API key is left as it was.
- **Concurrency.** One test call at a time, outside rep calling hours. That reduces but does not prove the absence of contention with live dialling, so any limit-style rejection is recorded as inconclusive and reported, not worked around.
- **Business rules.** No LLM adds, edits, merges, replaces or removes any business rule (grader questions, Yes/No rules, objection definitions, script checks, rubrics, trained replies, coaching text, eligibility rules) in any phase without Jarrad's verbatim approval — whether the rule lives in text, data or code. Phases 0 and 1 touch none.

### Questions

Results (Telnyx IDs, event names, hangup causes; no secrets) go in `.planning/direct-calling/FEASIBILITY.md`.

Must-pass regardless of D4 — a failure returns the design to planning; no silent topology swap:

| # | Question | Pass |
|---|---|---|
| F1 | Server dials the registered browser's SIP username; browser answers; server dials the test phone with `link_to`, `bridge_on_answer=true`, `bridge_intent=false`; two-way audio; test phone shows the D3 caller ID. | Yes, 5/5 |
| F2 | A browser connection with a **disabled** outbound profile still receives the server-dialed leg, and every browser-originated escape (PSTN, on-account SIP, external SIP, transfer) fails. Record actual codes. | Receive works. Each escape is a valid request to a known-working owned destination, from a verified-registered browser with spare capacity, and is rejected by the provider for a reason attributable to the restriction. A failure for any other reason (bad registration, unreachable endpoint, malformed request, capacity) is **inconclusive**, not a pass. |
| F3 | Browser can identify the exact leg before answering (`call.telnyxIDs`, `client_state`, `call.options` headers). | The ID the browser sees before answering **equals** the server's ID for the leg it created. If a fallback key is used instead, it must be shown to bind uniquely to one leg, and a second unexpected test leg to the same browser must be distinguishable and rejected. A field merely being present is a fail. |
| F4 | Stream on the seller leg with `both_tracks`: a spoken-marker test fixes which track is the seller and which is the rep; start frame format recorded. | Mapping unambiguous and repeatable |
| F5 | Dual-channel recording on the seller leg: party-to-channel mapping; `call.recording.saved` arrives; a fresh URL can be fetched by recording ID after the first link expires. | Mapping recorded; re-fetch works |
| F6 | DTMF sent by server command, and separately by the browser SDK, reaches the test phone across the bridge; server hangup ends both legs with matching webhooks. | Yes |

Must-pass only if D4 chooses **no recovery** (seller leg dialed without `park_after_unbridge`):

| # | Question | Pass |
|---|---|---|
| F7 | When the browser leg ends by clean hangup, killed tab, and network loss, the seller leg also ends. | Measured from the moment the fault is injected, both legs show terminal provider evidence within the F7 deadline set in D2, every time. Each case starts with enough leg-duration cap remaining that no cap can expire inside the deadline. The seller leg must end on its own: an ending caused by cap expiry or by any test cleanup command is a **fail**. Record timestamps and the provider's hangup cause for each leg. |

Must-pass only if D4 chooses **recovery**; skipped entirely otherwise:

| # | Question |
|---|---|
| R1 | With `park_after_unbridge=self`, the seller leg stays up and controllable ≥ 90s after the browser leg ends (clean hangup, killed tab, network cut). |
| R2 | That parked leg can be bridged to a newly dialed browser leg with two-way audio, 5/5. |
| R3 | Stream and recording across R1→R2 either survive or stop with a webhook; silent loss fails. |

Measure and record (shape the design; none is assumed as fact): **time from "call" to the test phone ringing and to two-way audio, and any dropped or failed attempts, across all test calls** — this is the evidence for D1, since the new path still runs on Telnyx and only helps if the Jitter hop is the cause; delay from credential creation to successful registration; whether deleting a credential drops a live registration or call; whether hold webhooks fire for an SDK hold and what `hold()` returns on failure; what a repeated Dial with the same `command_id` does, and for how long; effect of the app's "hang up on webhook timeout" setting; whether the Voice API app needs an outbound profile to dial an on-net SIP username; attestation; what the rep hears while the seller rings; how long the browser leg takes to be reported ended for a killed tab versus a network cut; behaviour on SDK 2.27.10 versus 2.27.1.

Exit: `FEASIBILITY.md` complete, teardown confirmed. Then revision 6 is written and reviewed (Fable, then Codex with repo access) before any Phase 2 work.

## Phase 2 — provisional outline for revision 6 (NOT approved)

This section records constraints and known traps so revision 6 starts from the repo as it is. It is not a build spec.

**Revision 6 must write out in full, not cite:** call state transitions and timeouts; handling of an unknown command outcome (never blindly re-dial a seller); orphan-leg cleanup; End overriding every other pending action; webhook signature, replay and dedupe rules; duration cap; pilot pass criteria; rollout and rollback rules; and, only if D4 chooses recovery, the full takeover and fencing rules.

**Call record identity.** Follow the Dialpad precedent rather than making the Jitter column nullable: keep `jitter_attempt_id` not null and write a namespaced synthetic value (pattern `telnyx-direct:<uuid>`, as `dialpad-cti:%` does in `20260929120000_dialpad_cti_call_projection.sql:84-88,275`), plus a `direct_call_id` column with a partial unique index. Revision 4's "no synthetic ID" rule is dropped because the repo's own convention and constraints contradict it. Known places that hard-code providers and must be handled, each with a test:
- `training_call_is_unlinked` allows only `sandra_softphone` and `dialpad` (`20260930036000_dialpad_training_projection.sql:5-9`); `prepareLeadCall` supports training leads (`actions.ts:94-99`).
- Acquisition reconciliation and its identity guard hard-code `provider='sandra_softphone'` and `'sandra-'||id` (`20260912130000_acquisition_call_reconciliation.sql:15-16,26,49-50`).
- Wrap-up derives `sandra-${...}` and inserts `provider: "sandra_softphone"` (`src/lib/dialer/actions.ts:377,427-428,449,458,496,536`) — risk of a duplicate row.
- Recording library source filters `provider in ('jitter','sandra_softphone')` (`20260915000100_recording_library.sql:189`); a direct source function is needed, as Dialpad has, alongside the `recording-url` branch and `src/lib/recordings/data.ts:143-175`.
- My Leads metrics count acquisition attempts joined to call activities, with some provider-specific handling (`20260930031000_dialpad_recording_provider_window_finalizer.sql:885-917`). Revision 6 separates "direct calls must reach the attempt/reconciliation path" from any provider-specific calculation; no metric rule is changed without Jarrad.
Revision 6 decides between a new provider value and reusing `sandra_softphone` with a transport column, after a full grep of provider literals.

**Softphone coupling.** `softphone-provider.tsx` is tied to Jitter beyond the transport factory: caller IDs load from Jitter on mount (39-42, 364-424), start intent is minted through Jitter (701-725), the build-time flag is read at 305, 533 and 701, and the factory is synchronous and documented as a non-shipping injection (105). A pilot user must make zero Jitter calls, so revision 6 needs a server-resolved transport decision threaded through all of these, not just a new factory.

**Minimum client build.** Commit SHAs have no order and the client has no build identifier today. Revision 6 specifies a monotonic build number (or an allowlist of accepted builds) exposed to the client.

**Eligibility.** DNC, quiet-hours and timezone rules live in `prepareLeadCall`/`prepareManualCall`/`classifyItem`, which use the user session and pause sequence enrollments. They must not be re-implemented in a worker. The pre-dial re-check goes through one Sandra-owned function that the worker calls; rule logic stays in one place and is not altered.

**Services.** Smallest shape first: one Railway service for call control and artifacts; coaching (`call-media`) as a second increment after calling works. Claim-loop template is `services/inbox-projection-worker` (polling, `SKIP LOCKED`), noting its restricted-role file is a candidate never run in production and a NOLOGIN role needs a login role to assume it — revision 6 specifies the actual role setup. New Telnyx webhook route with Ed25519 verification is net-new (no Telnyx webhook exists). Each service needs its own CI workflow. The test's outbound profile is not the production one; revision 6 names a separate profile and cap so direct calls do not share Jitter's spend limit.

**Coaching (blocked on D7).** Jitter's coach files are not a clean lift: `ingest-ws-server.ts` imports `./coach-tap-store`, `./types` and `./env`; `deepgram-live.ts` and `objection-prompt/index.ts` import `env.ts`, which imports Jitter's `@/env`; tests live in Jitter's `tests/coach-*.test.ts`. Revision 6 lists exactly which files are copied unchanged, which shims are new code, and where the speaker mapping changes (Jitter `types.ts:24` feeds the labels the objection logic reads). **No question, rule, prompt or approval file is copied, edited, merged or reworded without D7 and Jarrad's verbatim approval; any difference between repos is reported, not resolved.** Post-call summary or grading for direct calls may only use existing approved text; nothing is authored.

**Recording.** Gated on D5. New private bucket following the `dialpad-recordings` pattern; 60-second signed playback from Sandra storage.

**PR shape.** Each PR states `Depends on:`; children target the parent branch; Claude review then Codex adversarial review at the current head before merge. The actual sequence is set in revision 6.

## Verification

- Phase 0: `DECISIONS.md` exists with D1 answered; no application files changed.
- Phase 1: `FEASIBILITY.md` holds results for F1–F6, plus F7 (no recovery) or R1–R3 (recovery) according to D4 with the other branch recorded as intentionally skipped, the measured items, the resource inventory, and a post-teardown listing showing only pre-existing Telnyx resources. Existing Jitter and Dialpad calling untouched (no config diffs on existing resources).
- Revision 6 carries its own verification plan; none is approved here.
