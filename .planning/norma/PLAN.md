---
type: decision
status: active
tags: [sandra, crm, dialer, outreach]
created: 2026-10-02
updated: 2026-10-02
aliases: ["Norma build plan", "Have Norma call plan"]
related: ["[[Sandra]]", "[[Switchboard]]", "[[2026-10-02 — Norma (Bland AI) into Sandra — pilot design decisions]]"]
---
# Norma into Sandra — build plan v5 (for Astra review)

Supersedes the "Proposed plan, not yet approved" section of Astra's `DECISIONS-AND-CURRENT-CODE.md`. Revised by Claude after a design review with Jarrad on 2026-10-02. Decisions are recorded in [[2026-10-02 — Norma (Bland AI) into Sandra — pilot design decisions]]. Baseline: [[Sandra]] `origin/main` @ `6d678ad7`.

**Status: plan only. Not approved to implement. No code, no agent edits, no calls.**

**Review history:** v2 → Astra `APPROVE_PLAN: NO`, 8 blocking. v3 addressed all eight (marked `[F1]`–`[F8]`); Astra confirmed all eight fixed and raised 2 new blocking + 2 non-blocking. v4 addressed those (marked `[G1]`–`[G4]`); Astra confirmed fixed and raised 1 new blocking. v5 addresses it (`[H1]`). **Round 4: Astra `BLOCKING: 0`, `APPROVE_PLAN: YES` on v5 (2026-10-02).** Additions since ([I1], stress gate, caller-ID wording) went to Astra as a delta review: **`BLOCKING: 0`, `APPROVE_PLAN: YES`**; its non-blocking corrections to the stress invariants are folded into section 9.

## What changed from Astra's original plan, and why

| Astra's plan | This plan | Why |
|---|---|---|
| Add Norma as a voice action in the sequence engine | Standalone "call request", outside sequences | Step types are hard-wired in three places (check constraint in `018_sequences_v1.sql:70`, `replace_steps` RPC, if-chain in `tick.ts:249/677`), and `idx_enrollments_one_live_per_property` allows one live drip per lead, so Norma-as-drip would displace the SMS drip. |
| One call vs follow-up sequence choice | One call only. No follow-up option. | Jarrad: pilot is one call. |
| Now or later in the first build | Slice 1 = call now. Slice 2 = schedule later. | Jarrad approved the sequencing. Scheduled calls are held by Sandra and dialled by a cron after a recheck, not by Bland `start_time`. |
| Live warm transfer to the Dialpad sales department | **Parked.** Pilot is callback-only. | Pathway has no Transfer Call node; plan shows `status: "none"`; warm transfer is enterprise-only; rep accept/decline and transfer-leg voicemail detection are undocumented. |
| Shared eligibility infrastructure | Two hard blocks only: do-not-contact and `not_interested`. | Jarrad: calling hours and seller interest are the rep's judgement. |
| Callback ownership open | Callback tasks assigned to Jarrad. | Jarrad's decision. |
| Script wording adjustment proposed | Not in this plan. | Astra's MCP read shows staging `0.0.17` already prohibits claiming transfers/bookings and exposes `call_outcome` / `follow_up_preference`. Map existing fields first; any text change is a Jarrad gate. |

## Decisions this plan implements
- Button visible to all active members.
- Hard blocks: DNC (lead lock and global registry) and `not_interested`.
- No answer: leave the short callback voicemail on a single call and on call-twice attempt 2; hang up on attempt 1 when that attempt number is present. No Bland-side retry. `pathway_version` is omitted unless `NORMA_BLAND_PATHWAY_VERSION` is a strict integer, so Bland uses the published production pathway.
- Drip: pause on request; resume on confirmed no answer; stay paused if Norma reached the seller.
- Seller tells Norma to stop: lead marked `not_interested` (not DNC).
- Callback requested: callback task for Jarrad, labelled unconfirmed.
- Caller ID: build and rehearse on the existing 213 number (no new number fee; calls still draw on Jarrad's prepaid Bland credits at $0.14/min — balance was $15.55 of $20 on 2026-10-02, and whether the 213 number itself is billed is not visible in the account data). Before real sellers, Jarrad chooses between a $15/mo Bland 816 number and a bring-your-own Twilio number (~$1/mo, plan eligibility unverified). No free swap is documented; do not release the 213 number. Callbacks: Norma answers, then transfers to the Dialpad main line (a silent straight-through forward is not documented; inbound answer-and-transfer must itself be verified at rehearsal and is not evidence that outbound warm transfer works).
- Rehearsal on Jarrad's own phone before any real seller.

## Slice 1 — "call now"

### 0. Dispatch gate `[F7]`
Server-side, disabled by default, enforced inside the single dispatch function that every path (server action, sweep, slice-2 cron) must call:
- `NORMA_DISPATCH_ENABLED` must be true, else refuse.
- While `NORMA_SELLER_RELEASE` is not set, the destination number must be in `NORMA_ALLOWED_NUMBERS` (Jarrad's phone). Releasing real sellers is a Jarrad gate.
- Tests: direct action invocation with a non-allowlisted number refuses; cron path refuses; gate off refuses.

### 1. Data (one migration, established Sandra migration workflow)
`norma_call_requests`:
- `id`, `org_id`, `property_id`, `contact_id`, `phone_e164`, `requested_by`, `rep_context text`
- `status`: `requested → dispatching → dispatched → completed`, plus `dispatch_rejected`, `dispatch_unknown`, `needs_review`. Transitions are monotonic and enforced in SQL; no transition may leave `completed`. `[F2][F3]`
- `idempotency_key uuid` (sent to Bland in `metadata`), `bland_call_id text unique` (nullable)
- `outcome`: `no_answer | callback_requested | reached_no_callback | not_interested | wrong_number | unknown`
- `callback_requested_for`, `callback_timezone`, `callback_raw`, `qualification jsonb`, `summary`, `completed_at`
- Partial unique index on `property_id` where `status in ('requested','dispatching','dispatched','dispatch_unknown','needs_review')` (slice 2 adds `scheduled`). Uncertain attempts keep blocking a redial until a human or reconciliation resolves them. `[F2][F6]`

`norma_enrollment_pauses (request_id, enrollment_id)`: the enrollments this request itself paused. `[F4]`

`norma_notifications (request_id, kind, status, attempts, next_attempt_at, slack_ts, unique(request_id, kind))`: Slack outbox. `[F8]`

Tasks: add a nullable `source_key text` with a unique index so a Norma callback task can be created at most once per request (`createTask` is an unconditional insert, `src/lib/tasks/index.ts:66`). `[F3]`

Extend `PauseReason` with `norma_call`; add lead event types `norma_call_requested`, `norma_call_completed`. No `call_activities` or `acquisition_attempts` rows in slice 1 (an `acquisition_attempts` `no_answer` would create a rep-SMS obligation for a call no rep made).

### 2. Request and dispatch `[F1][F2][F4]`
`requestNormaCall(propertyId, repContext)` (session-authenticated):
1. Active membership; training-lead guard.
2. Select the exact destination number first (new voice phone helper, specified separately from `selectBestSmsPhone`, which ranks for SMS and only falls back to a landline, `sms-phone.ts:48`; voice ranks any callable, not-wrong number) `[G3]`.
3. Eligibility RPC `fn_norma_eligibility(property, contact, phone)`: `is_dnc_locked`, a direct query of `global_phone_dnc_registry` for that number (`evaluateSuppression` only evaluates fields passed to it and queries nothing, `suppression.ts:39`), contact still belongs to the property, disposition is not `not_interested`. Any read error fails closed.
4. Insert the request (`requested`) with a fresh `idempotency_key`. The unique index is the concurrency guard.
5. `fn_norma_pause_for_request`: pause the property's active enrollments with `norma_call` and record them in `norma_enrollment_pauses`, in one transaction.

`dispatchNormaCall(requestId)` (the only function that calls Bland):
1. Dispatch gate (section 0).
2. Atomic claim: `requested → dispatching` (single conditional update; losers exit).
3. Re-run `fn_norma_eligibility` immediately before dialling; if it fails, mark `dispatch_rejected` and release owned pauses.
4. Bland send-call: pathway id, omit `pathway_version` unless `NORMA_BLAND_PATHWAY_VERSION` matches `/^(0|[1-9]\d*)$/` and `Number.isSafeInteger` (blank or `production` uses Bland's published production version; `latest` is not an alias), `from` = local number, `metadata {request_id, idempotency_key}`, webhook URL, voicemail `leave_message` unless `attempt` is present and is not 2 (then `hangup`), `record` true, `max_duration` 10 minutes, no `retry`, rep context and lead facts as variables.
5. Result handling:
   - Explicit rejection (4xx with no call created): `dispatch_rejected`; release owned pauses.
   - Success: bind `bland_call_id` and move `dispatching → dispatched` with a conditional update that cannot overwrite `completed`.
   - Timeout, 5xx, or failure writing the id: `dispatch_unknown`. Never auto-redial. Pauses stay. Reconciliation (section 6) resolves it.

### 3. Webhook `POST /api/webhooks/bland/call` `[F3][F5][F6]`
- Verify `X-Webhook-Signature` (HMAC-SHA256, raw body, size-bounded) before parsing.
- Correlate by `metadata.request_id` + `idempotency_key`; do not require a stored `bland_call_id`. Validate the dialled number equals `phone_e164`.
- All CRM effects happen in one service-role RPC, `fn_norma_complete_call(request_id, call_id, outcome, payload)`:
  - Locks the request row (`for update`); if already `completed`, returns `replayed` with no effects. Webhook and sweep both go through this RPC, so they serialise.
  - Binds/validates `bland_call_id`; accepts completion from `dispatching`, `dispatched`, `dispatch_unknown` or `needs_review` (covers a webhook arriving before the id is stored, and a late webhook after escalation). When completing from `needs_review`, the RPC applies the real outcome and closes or retitles the review task (same `source_key`) instead of creating a second one. Tests: escalation → late completion → replay. `[G1]`
  - Writes outcome, lead event (`on conflict (source_type, source_id) where source_id is not null do nothing`, matching the partial index in `20260825170000_lead_events_ledger.sql:44`) `[G4]`, task (unique `source_key`), disposition, pause handling, and the `norma_notifications` row — all in the same transaction.
- Outcome mapping from Bland `answered_by`, `status`, and the pathway's existing `call_outcome` / `follow_up_preference` variables. Anything that does not map cleanly is `unknown`.
- Effects by outcome:
  - `no_answer` (confirmed by Bland status, not inferred): release owned pauses.
  - `callback_requested`: callback task, assignee = pilot assignee (Jarrad), due = requested time, title marks it unconfirmed. Pauses stay.
  - `reached_no_callback`: callback task due now. Pauses stay.
  - `not_interested`: the RPC writes `outreach_dispo = 'not_interested'` itself, preserving DNC precedence (never downgrades a DNC lead), and keeps the pause. It does not reuse `setOutreachDispo` (session-auth only, and its pause branch covers DNC/opt-out, not `not_interested`, `dispo-actions.ts:132/207/273`) or Switchboard's RPC (handles only null/already-not-interested). No DNC write.
  - `wrong_number`: the same RPC marks the dialled number wrong using the existing wrong-number columns, keeps the pause, creates a task for Jarrad.
  - `unknown`: status `needs_review`, pauses stay, the request keeps blocking redial, task for Jarrad to resolve. Automation never resumes on an unknown result.

**Norma hold, independent of pause reason `[G2]`.** An open request (`requested`, `dispatching`, `dispatched`, `dispatch_unknown`, `needs_review`) is itself a hold on the property's enrollments, whatever their `pause_reason`. An enrollment already paused as `call_in_progress` by the softphone is not owned by Norma and keeps its reason, but it must not resume while the hold is open. Enforce this in one shared SQL guard, `fn_norma_hold_active(property_id)`, called by every resume path: `resumeByProperty` (`enrollment.ts:365-380`), `resumeEnrollment`, the resume RPC in `20260919090000_sequence_runtime_recovery.sql`, and the direct activation in `sweep-stuck-call-in-progress/route.ts:76`. `sequence-tick` also skips enrollments whose property has an active hold, as defence in depth. When the hold ends, Norma releases only its owned pauses; a softphone pause is then picked up by its own existing cleanup or the 5-minute stale-call sweep. Outcomes that keep the drip paused (reached, callback, not interested, wrong number) convert any non-owned `call_in_progress` pause on that property to `norma_call` inside the completion RPC so it does not resume later. Tests: existing softphone pause → Norma dispatch → softphone cleanup (no resume); then Norma no-answer (resumes via sweep); then Norma reached (stays paused).

**Replies during a hold `[H1]`.** Today an inbound reply only pauses active enrollments (`inbound.ts:828`, `enrollment.ts:307-309`) and takeover promotion only upgrades `inbound_reply` (`inbound.ts:914-917`), so a reply that lands while an enrollment is already paused (`norma_call`, or a non-owned `call_in_progress` under a Norma hold) would leave no trace and the drip could resume after a Norma no-answer. Change the inbound-reply and human-takeover paths so that, when the property has an active Norma hold, they upgrade both `norma_call` and `call_in_progress` pauses to `inbound_reply` / `rep_sms_human_takeover`, never overriding terminal or DNC reasons. Once upgraded, neither Norma's release, softphone cleanup, nor the stale-call sweep (which only touches `call_in_progress`) will resume it. Regression tests: softphone pause → Norma request → seller SMS → Norma no-answer → run softphone cleanup and the stale sweep → enrollment still paused as `inbound_reply`; same with a rep takeover. `[I1]` Automatic softphone cleanup must pass its expected pause reason (`call_in_progress`) to the resume RPC, which validates it under the enrollment lock before activating (`resumeByProperty` checks the reason only when selecting candidates, `enrollment.ts:369-385`; the RPC accepts other paused reasons, `20260919090000_sequence_runtime_recovery.sql:630-665`). The expected-reason check happens before any claim retirement or activation. Add the interleaving cleanup-selects → reply upgrades → Norma no-answer → cleanup RPC runs to the regression tests. (The same gap exists today for a reply during a plain softphone pause with no Norma involved; that is a pre-existing issue, noted for a separate fix, not part of this plan.)

**Releasing owned pauses** = `fn_norma_release_pauses(request_id)`: for each enrollment in `norma_enrollment_pauses`, resume only if it is still `paused` with `pause_reason = 'norma_call'` and still passes current pause/eligibility rules. An enrollment whose reason changed in the meantime (inbound reply, human takeover, terminal status, DNC) is left alone. Because `pausePropertyEnrollments` only updates active rows (`enrollment.ts:307`), a later inbound reply would not overwrite `norma_call`; so the inbound-reply and human-takeover paths must be changed to also upgrade a `norma_call` pause to their own reason. Tests: reply during Norma pause, DNC during pause, disposition change during pause.

### 4. Slack channel post (new path) `[F8]`
Sandra today only DMs individual users (`src/lib/integrations/slack/dispatch.ts:84-111`). Add a channel post using the BMH outreach bot token and Switchboard's deployed channel ID (env values). A notification worker drains `norma_notifications` with backoff, stores `slack_ts` on success, and never touches CRM state. Content: seller, property, qualification answers, outcome, requested callback time marked unconfirmed, deep link to the lead.

### 5. UI
- `HaveNormaCallButton` in `heroActions` (`leads/[id]/page.tsx:644+`), inside the `fieldset disabled={training}` wrapper.
- Panel: seller, property, number to be dialled, any block with its reason, optional context box, Confirm.
- Timeline renderers for the two event types; in-flight and needs-review state shown from the request row.

### 6. Reconciliation sweep `[F2][F6]`
Cron every 5 minutes over `requested` (stranded), `dispatching`, `dispatched` and `dispatch_unknown` rows past a threshold:
- Look the call up in Bland by `bland_call_id`, or by `metadata.idempotency_key` when no id was stored.
- Call found and finished → `fn_norma_complete_call` (same path as the webhook).
- Bland confirms no call exists → `dispatch_rejected`, release owned pauses.
- Still ambiguous after a longer threshold → `needs_review` + task. Never redial, never resume. `needs_review` rows are rechecked against Bland on a slower cadence and still accept a late webhook (section 3). `[G1]`
- Stranded `requested` rows are dispatched only if younger than a short window; otherwise `dispatch_rejected` with pauses released.
- **Deviation (M2, accepted):** Bland cannot be queried by metadata, so "Bland confirms no call exists" is only possible for a bound call id, and a 404 on a bound id is treated as ambiguous: it escalates to `needs_review` after the window instead of `dispatch_rejected` (a call that Bland once accepted is never auto-closed). Rows with no id escalate by age. The sweep orders by `next_check_at` and pushes each examined row out, so stuck rows cannot starve fresh ones; "close only if still `requested`" callers pass an expected status so they cannot reject a row a dispatcher already claimed.

### 7. Dispatch contract
**Pathway:** Sandra does not pin a version. Omitting Bland `pathway_version` uses whatever version is published as production. `NORMA_BLAND_PATHWAY_VERSION` pins only when it is a strict non-negative integer (`/^(0|[1-9]\d*)$/` and `Number.isSafeInteger`). Unset, blank, and `production` omit the field. `latest` is not accepted. `call_outcome` leading token map and the nine extraction variables are in `src/lib/norma/outcome.ts`. The callback preference is free text, so callback tasks are due now with the raw text in the description.
The outcome map still reads the pathway's `call_outcome`, `follow_up_preference`, and qualification fields. A pathway publish that drops one of those fields is a Jarrad gate.

### 8. Verification
- Unit: eligibility (incl. global registry and fail-closed), dispatch gate, state transitions, outcome mapping, signature check.
- Integration: each outcome end to end with Bland mocked; webhook-before-id; webhook replay; webhook vs sweep concurrency (one task, one event); dispatch timeout → `dispatch_unknown` blocks a second request; Slack failure leaves CRM state intact and retries.
- Playwright: button, panel, blocked states, timeline entry.
- Rehearsal on Jarrad's phone (allowlisted): answer and give a callback time; don't answer; ask to stop.

### 9. Stress gate (required before the rehearsal) — added 2026-10-02 at Jarrad's request
No real calls; nobody is dialled. Runs against a local/test database with a fake Bland server.
- **Misbehaving fake Bland.** A test double for send-call, call lookup and webhook delivery that can be told to: time out after accepting the call, return 5xx, reject, deliver the webhook before the send-call response, deliver it twice or many times, deliver it late (after `needs_review`), deliver out of order, never deliver, and send malformed or unmapped payloads and bad signatures.
- **Randomised runs.** A seeded generator drives several hundred request lifecycles mixing those faults with concurrent events: inbound seller SMS, rep takeover, DNC write, `not_interested` write, softphone pause and cleanup, the stale-call sweep, the reconciliation sweep, and Slack failures. Failing seeds are printed so a run can be replayed.
- **Invariants, checked across every recorded state transition (not only the final snapshot); execution traces are kept:**
  1. At most one Bland call is ever created per request, and at most one open request per lead.
  2. No dispatch (defined as the moment the send-call request is issued) to a number that is DNC or a lead that is `not_interested` at that moment, or with the dispatch gate off / number not allowlisted.
  3. Outcome-specific effects, exactly once however many webhooks arrive: one completion event; a task only for the outcomes that require one (callback, reached-no-callback, wrong number, unknown — none for `no_answer` or `not_interested`) with the right assignee, due time and title; correct disposition / wrong-number writes; and full rollback of all of them on an injected database failure.
  4. Invalid signatures, or a mismatched request id, idempotency key, dialled number or call id, produce zero CRM effects.
  5. Once the request's pause step has committed, no enrollment on that lead is active while the Norma hold is open. Release changes only eligible, owned `norma_call` pauses; takeover, inbound-reply, terminal and DNC pauses are preserved; a confirmed no-answer eventually releases the eligible ones.
  6. Unresolved ambiguity keeps the redial fence; a later valid completion applies its effects once and closes or retitles the existing review task without a duplicate; `completed` never regresses.
  7. Within a virtual-clock horizon, with the recovery workers running, every request reaches a terminal or `needs_review` state.
  8. Slack: exactly one durable outbox item per request, Slack failures never change CRM state, and delivery eventually succeeds after recoverable failures. A post accepted by Slack whose response is lost may duplicate on retry; that ambiguous-acceptance case is tested separately and the duplicate is accepted (or deduplicated by a client message key if Slack supports one).
- **Named races use barriers, not luck.** Seeds reproduce inputs, not database scheduling, so each named interleaving (webhook-before-id, webhook vs sweep, cancel vs dispatch, reply during hold, and the `[I1]` cleanup race) is forced with explicit barriers.
- **Button hammer.** Twenty simultaneous `requestNormaCall` invocations for the same lead (and the same from two users) produce exactly one request and one dispatch, with the fake call held open for the duration (a completed call legitimately allows a new request).
- The gate is green only with zero invariant violations across the full randomised run; it runs in CI on this feature's PRs.
- Repeated real calls to Jarrad's phone are not part of this gate; that is his decision at rehearsal time (it costs call minutes).

## Slice 2 — "schedule for later"
Add `scheduled_for` and status `scheduled` (included in the unique index). A cron calls `dispatchNormaCall` for due rows, so the gate and eligibility recheck apply at dial time. Drip pauses at dispatch. Cancel is a conditional update `scheduled → cancelled` that cannot race the `→ dispatching` claim.

## Parked — live handoff
Un-park only when Bland confirms warm transfer on the account, a Transfer Call node exists, and a Bland test-panel run shows correct behaviour for accepted, declined, unanswered and voicemail-answered transfers.

## Gates — Jarrad only
1. Spend: buying the local Bland number.
2. Any change to Norma's script or pathway text. Exact text approved verbatim, one approval per text.
3. Applying the migration.
4. Bland account configuration: webhook secret, inbound forwarding on the new number.
5. Turning on `NORMA_SELLER_RELEASE` (first calls to real sellers).

## Unverified
- Whether a Bland inbound number can forward to the Dialpad main line without an agent answering.
- Whether Bland can look a call up by metadata (needed for reconciliation without a call id); if not, reconciliation of id-less attempts goes straight to `needs_review`.
- Whether `metadata` is echoed in every webhook, and Bland's webhook retry behaviour.
- Switchboard's deployed Slack channel ID and the BMH outreach bot token.
- The existing wrong-number columns/write path to reuse inside the completion RPC.
