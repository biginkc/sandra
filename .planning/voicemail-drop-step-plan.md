# Voicemail drop step in drip campaigns — plan v3 (Fable approved)

Status: plan only, build not authorized. Date: 2026-10-20.
v3 folds in both Fable reviews (RULINGS RVM-1..5, findings 1–7, re-review fixes 1–4). Fable: v3 with those fixes is FABLE_APPROVE YES.
Provider: Drop Cowboy (primary), VoiceDrop.ai (fallback, thinner API).
Audience: only sellers the team has already spoken to. Legal is owned by Jarrad; this plan covers implementation only.

## What the user sees

In the sequence editor, a new step type **Voicemail drop** sits next to "Send SMS" and "Change status":

- Pick a recorded message (uploaded once in Drop Cowboy, listed in Sandra), **or** write a script with merge fields (`{{first_name}}`, `{{property_address}}`, the same syntax and engine as SMS steps; the worker renders them before the POST, so no `{`/`}` ever reaches Drop Cowboy, which treats braces as its own merge fields) spoken by Norma's cloned voice.
- Same delay/scheduling controls as SMS steps.

On the lead page, each drop shows in the activity timeline: queued → delivered / failed (plain reason, e.g. "voicemail box full"), plus a proof-of-delivery recording link while Drop Cowboy keeps it (7 days).

## Voice (RULING RVM-1)

Drop Cowboy TTS with a cloned Norma voice (`tts_body` + `voice_id`). Not Bland-rendered `audio_url`: that field needs a BYOC carrier trunk (`/integration/public/byoc/connect`, `caller_id`, STIR/SHAKEN), plus audio storage and URL expiry, for no product gain. Sample clip for cloning already generated from Bland (`norma-voice-sample.wav`, 32s). Open for Jarrad: "Karen" is Bland's curated voice — licensing call is his.

## Who gets a drop (RULING RVM-2, RVM-3)

"Already spoken to", scoped to the same `contact_id`, any of:
- `acquisition_attempts.outcome = 'reached'`
- `call_activities.talk_duration_seconds > 0`
- an inbound `messages` row

Same facts the work-facts RPC already uses (`20261015020200_…sql:204-212`). Do **not** use `call_activities.outcome='connected_human'` (Jitter-only) or `getConsentState(…,'voice')` (no voice events are ever written; would block every drop).

Plus: phone present, `do_not_contact` false, not opted out, no pausing `outreach_dispo`.

Number: the phone from the qualifying event when known, else the primary mobile slot. Always `mobile_only: true`, `max_attempts: 1`, `postal_code` = property zip.

## How it fits the existing code

| Piece | Today | Change |
|---|---|---|
| Step types | `action_type` ∈ `send_sms`, `change_status` (018:70) | Add `send_voicemail_drop` + columns `vm_media_id`, `vm_tts_body`, `vm_voice_id`, `vm_phone_line_id`; widen body-xor constraint (035/041) to "exactly one of media / tts for drop steps" |
| Step RPCs | `sequence_replace_steps` rejects other types (`20260929238000_…sql:67`); `sequence_copy_steps` lists columns (`20260929239000_…sql:220`) | Update both in the same migration — otherwise tick.ts:881 marks the step `provider_failed` |
| App surfaces | `starter-library.ts:25` union, `drip-choices` / `drip-progress` counts, `detail-view.tsx:54` label | Add the new type everywhere |
| Worker | `src/lib/sequences/tick.ts` | New branch beside `send_sms`, same claim/advance flow |
| Provider layer | `MessagingProvider` is SMS-only | New `VoicemailDropProvider` in `src/lib/voicemail-drop/` (`dropcowboy` + `mock`), selected by `VOICEMAIL_DROP_PROVIDER`; unset = feature off |
| Log | `call_activities` is Jitter-shaped | New table `voicemail_drops` |
| Webhooks | `webhooks/<vendor>/…` + `webhook_events` dedupe | `webhooks/dropcowboy/rvm` (signed) and `webhooks/dropcowboy/rvm-callback/[secret]` |
| Quiet hours | SMS claims then retires on `blocked_quiet_hours` | Call `checkQuietHours(property.state)` before POST and reuse the same retire/reschedule block |

### `voicemail_drops` table

`id`, `org_id` (RLS, per-org caps), `enrollment_id`, `step_run_id` (unique), `idempotency_key`, `contact_id`, `property_id`, `to_phone`, `provider`, `drop_id` (Drop Cowboy's id, from callback), `audio_kind` (media/tts), `rendered_script`, `status` (`queued`, `delivered`, `failed`, `skipped`), `attempt_outcome` (`queued`, `not_queued`, `unknown`), `reason_code`, `reason`, `proof_url`, `cost`, `provider_payload` jsonb, `queued_at`, `completed_at`.

### Worker branch (`send_voicemail_drop`)

1. Eligibility (above). Not eligible → step run skipped with new `skipped_reason = 'not_eligible'`, enrollment advances.
2. Quiet hours check; outside → retire claim and reschedule (SMS path).
3. Per-org daily cap (`VOICEMAIL_DROP_DAILY_CAP`); over → reuse the quiet-hours retire block verbatim (`claim_active = false`, `attempt_outcome = 'not_attempted'`), reschedule to next day. Leaving the claim live would hit 23505 → stale-claim → `provider_failed`.
4. Insert `voicemail_drops` row, render merge fields deterministically (≤1,200 chars). Same key + different body gives Drop Cowboy error 3027, so the render must not change between attempts.
5. `POST https://api-v2.dropcowboy.com/rvm` — `x-key`/`x-secret`, `Idempotency-Key = step_run_id`, `to`, `tts_body`+`voice_id` or `media_id`, sender (`caller_id` when `DROPCOWBOY_CALLER_ID` is set, else `phone_line_id`; never both, because Drop Cowboy ignores `caller_id` when `phone_line_id` is sent), `foreign_id = voicemail_drops.id`, `callback_url`, `mobile_only`, `max_attempts: 1`, `postal_code`.
6. Results (RULING RVM-4, finding 3) — never blind-retry:
   - `202` → drop `queued`; step run `attempt_outcome = 'accepted'` (constraint `20260919090000:23`), `message_id` null; advance. The step advances on 202 only.
   - `429` / `500` → not queued, release claim, retry next tick.
   - `502` (`SendQueueNoReceipt`), timeout, network error → `attempt_outcome = 'unknown'`, pause enrollment `reconciliation_required` (same as SMS, tick.ts:430-470). A retired stale claim gets a new run id and so a new key; that's why unknown must never re-fire.
   - `400` (`SendBadRequest`: malformed body/headers, i.e. an adapter bug) → pause `provider_failed` + `reportError`.
   - `401` → pause + `reportError`.

### Status updates (RULING RVM-5)

- **Callback route** (`callback_url`): only payload that echoes `foreign_id` and carries `drop_id`. Unsigned, single attempt — secret path, reject unknown `foreign_id`, persist `drop_id`.
- **Signed webhook** (`contact.rvm.status` / `contact.rvm.receipt`): verify `X-Signature = sha256=HMAC(signing_secret, X-Timestamp + "." + rawBody)`, dedupe on `event_id`. Match on `drop_id` first, then a unique (`to`, `status=queued`, `queued_at` within 72h); otherwise store unmatched in `webhook_events` — never guess.
- **Failures after the 202** arrive by callback after the enrollment already advanced:
  - Config-class (bad `voice_id`/`phone_line_id`, `3021` script too long, `4010` no line) → pause `step_misconfigured`.
  - Consent-class (`4016` DNC; `6005`/`6011` — not in the saved spec, unverified, confirm in probe 0) → pause with a visible reason.
  - Delivery-class (`4001` no voicemail, `4002` box full, `4007` not mobile) → only mark the drop failed.
  - `pause_reason` is free text (`20261008143600:5`), so new reasons need no migration.
- No `consent_events` writes from provider codes without Jarrad's text approval.

### Env vars

`VOICEMAIL_DROP_PROVIDER`, `VOICEMAIL_DROP_DAILY_CAP`, `DROPCOWBOY_API_KEY`, `DROPCOWBOY_API_SECRET`, `DROPCOWBOY_PHONE_LINE_ID`, `DROPCOWBOY_VOICE_ID`, `DROPCOWBOY_WEBHOOK_SECRET` (contact.rvm.status subscription), `DROPCOWBOY_RECEIPT_WEBHOOK_SECRET` (contact.rvm.receipt subscription; each subscription has its own signing secret), `DROPCOWBOY_CALLBACK_SECRET`, `DROPCOWBOY_CALLER_ID` (BYOC: the dedicated Telnyx number, E.164; when set, drops send `caller_id` and steps no longer need `vm_phone_line_id`). `DROPCOWBOY_VOICE_ID` / `_PHONE_LINE_ID` are only editor defaults; the step's `vm_voice_id` / `vm_phone_line_id` columns are authoritative.

## Callback number (finding 5)

Update 2026-10-20: use BYOC with our existing Telnyx account (cheaper per drop). Caller ID is one dedicated new Telnyx number used only for drops, never an existing live-call number, so drops can't get those flagged. Its inbound calls forward to Norma's number (Bland), and Norma answers and transfers to the team. The inbound-call pause triggers off Norma's inbound call record (Bland post-call webhook, caller phone → contact). If forwarding hides the caller's number, fall back to Telnyx inbound events on the drop number. No Dialpad forwarding needed. RVM-1 (Drop Cowboy TTS + cloned voice) still stands; BYOC would allow `audio_url`, but there's still no product gain. Today an inbound call after a drop does not pause the drip (only an inbound text does) — product question for Jarrad.

## Build order

0. **Probe first** (throwaway script, Drop Cowboy test number): does the account block drops for `6011`/`6005` without a Drop Cowboy consent record, and does the callback echo `foreign_id` + `drop_id`? Result decides whether PR 2 needs a consent-record call.
1. Migration: action type, step columns, constraint, both step RPCs, `skipped_reason` check + TS union gain `not_eligible` (018:154, tick.ts:953), `voicemail_drops`.
2. Provider layer: interface, mock, Drop Cowboy adapter, tests against recorded payloads.
3. Worker branch: eligibility, quiet hours, cap, result handling, tests (mock).
4. Callback + webhook routes, correlation, reason mapping, lead timeline entry.
5. Editor UI + starter library, drip counts, labels; media/voice pickers.
6. Canary: owned numbers only, one drop per path (TTS, media, failure), then one small live campaign.

## Needs Jarrad

- Drop Cowboy account (from ~$125/mo + ~$0.02–0.045/drop), US identity verification, buy a voice slot, clone Norma from the sample clip, forward the Drop Cowboy line to Dialpad.

## Decided by Jarrad (2026-10-20)

- Norma (Bland) answered calls count as "spoken to". Build: confirm Norma's answered calls land as `call_activities` rows with `talk_duration_seconds > 0` for the right `contact_id`; if not, add them to the eligibility query explicitly.
- A seller calling back pauses the drip. Build (PR 4): on an inbound call from a contact's phone (Dialpad inbound call or the forwarded Drop Cowboy line), pause that contact's active enrollments with `pause_reason = 'inbound_call'`, mirroring the inbound-SMS pause.
