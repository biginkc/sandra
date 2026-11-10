# Alert noise fixes — plan (2026-11-10)

Base: `origin/main` @ `0175c6f09`. Branch `claude/alert-noise-fixes`. One PR. `Depends on: none`.

## Why

On 2026-11-10 the owner received 36 alerts (Slack DM + text each). An independent audit judged 23
of them not worth a ping. The classifier (Jev) read ~82% of 164 replies correctly; most of the noise
comes from alert rules that run after classification. Separately, 7 sellers who had just said no and
then acknowledged our check-back text ("Ok" / "Sure" / "Thanks") were sent the book-appointment reply.

## Owner decisions (Jarrad, 2026-11-10, this session)

Approved behaviour, stated by him or confirmed by him from a plain-English list:

1. A seller who says no a second time does not ping him.
2. "Stop" / "Wrong #" from a number we cannot tie to one property does not ping him.
3. One text never pings him twice.
4. "500 k" (space before the k) is read as a dollar amount.
5. A seller who said no and then sends "Ok" / "Sure" / "Thanks" gets no text from Sandra.

Explicitly unchanged by his decision:

- Every reply from a seller already on My Leads still pings him (`lead_reply`), subject only to fix 3.
- When Jev has no road and Haiku is unsure (`haiku_unsure`), and for `possible_stop`, he is still pinged.
- Price texts with no dollar amount at all still alert (`no_single_amount` → fair-price reply + alert),
  except the existing `asked_offer_no_amount` branch (`price-check.ts:105`), which books. Unchanged.

No reply text, question wording, cutoff, or order-table row is added or edited by this plan. If a
builder finds a fix needs any of those, stop and report; do not draft wording.

## Fixes

### F1 — repeat "no" does not alert

Today: `dispatch.ts` `notSent` → `repeatNoHold()` calls `enqueueV2ReplyRepeatAlert` whenever a v2 reply
is cancelled `template_already_sent` with `ok_no_hold` (added 2026-11-08 so a silent suppression is
never invisible). Ten of today's alerts were this, nine on the `not_interested` reply.

Change: skip the `reply_repeat` alert when the suppressed reply row's `payload.key` is
`not_interested`. Every other reply key keeps today's alert. The suppression of the duplicate text is
untouched. Decide from the outbox reply row already read by `enqueueV2ReplyOwnerAlert` (do not
re-classify, do not read Jev probabilities).

A repeat on any other template (e.g. `said_yes`) still alerts, subject to the F3 coverage rule
(Astra r1 #3): no `reply_repeat` when another alert already covers that inbound.

### F2 — unmatched-number keyword texts do not alert

Today: `loadAmbiguousThreadAlerts` alerts on every inbound with `property_id` null and an ambiguous
threading outcome; it never reads the body. `messaging/inbound.ts` already handles a carrier STOP
with no property by `applyPhoneLevelOptOut` and stamps `metadata.keyword = "stop"`.

Change: the loader skips a message whose keyword branch **fully handled it without a property**.
- Carrier STOP (`metadata.keyword === "stop"`): skip. The phone is already opted out.
- Wrong-number keyword: KEEP the alert (resolved by Astra r1 #4). With no property the
  wrong-number branch sets no disposition, retires nothing and writes no hold
  (`inbound.ts:638,665,686`), so the owner's ping is the only thing that stops further texts to
  that number. The owner is told this fix covers STOP only.
- The drain path (unfinished delivery pairs) is unchanged: an alert already started still finishes.

### F3 — one alert per inbound text

Two observed double pings:

a. `lead_reply:<inbound>` + `routing_v2:<inbound>:<reason>`. `loadLeadReplies` skips only when a
   `hot_text` / `hot_handoff` / `hot_failed` / `lead_reply` key or hot event exists; it does not know
   routing v2's own alert keys.
   Change: also leave the text to routing v2 when `routing_v2_outbox` has an alert row for that
   inbound whose status is not `cancelled` (`pending`, `claimed`, `sent`). A cancelled alert (e.g.
   `time_only_alert_disabled`) does NOT suppress the lead reply: the owner decision "every lead reply
   pings" must still hold. An unanswerable lookup skips this pass and retries (existing pattern:
   never two alerts, never a lost one — `complete = false`).
   Guarantee is narrow (Astra r1 #5): alerts queued by the initial transition exist once dispatch
   completes its claim. Residual, documented in the PR body and NOT fixed here: (i) `dispatchDone`
   turns true after 30 minutes without completion; (ii) `reply_failed` / `reply_repeat` are queued at
   reply-delivery time, after the claim completes, so a lead reply can already have gone out.

b. `reply_failed` or `reply_repeat` + another `routing_v2` alert for the same inbound.
   Change, in the shared `enqueueV2ReplyOwnerAlert` (so both reasons get it): return `"skipped"`
   when another alert **covers** the inbound. Coverage rule (Astra r1 #2, #3) — an alert row for the
   same inbound, different reason, that WILL reach the owner:
   - status `sent`; or
   - status `pending` / `claimed` and NOT conditional (`payload.when_time_only_off !== true`); or
   - status `pending` / `claimed`, conditional, and `alertOnTimeOnlyInForce(freshFlags, propertyId)`
     is false right now (so the delivery gate will send it).
   A conditional `hot_yes` that the gate is going to cancel (`time_only_alert_disabled`) never
   covers: `reply_failed` / `reply_repeat` is queued as today, so the owner still gets exactly one.
   A cancelled row never covers. Reads needed (Astra r2 #3): the helper's reply-row SELECT adds
   `payload` (for F1's key check) and its existing-alert query returns `status`, `payload` for all
   alert rows of the inbound, not just `id`. Flags come from the strict `readRoutingV2FlagsResult`;
   a flag-read failure returns `"error"` (the ordinary reader's ALL_OFF fallback would fake
   coverage) and is tested. Flags are read fresh at this call; a flag flip between this read
   and delivery is an accepted residual (follow-up, not handled).
   `"skipped"` is treated by both `reply_failed` callers (dispatch-time hold and the `holds_due`
   sweep) exactly like `"exists"`: hold written and marked, no retry loop. A failed coverage lookup
   returns `"error"` (retry obligation kept), never `"skipped"`.

Out of scope: three alerts from three different texts by one seller. That is three texts.

### F4 — "500 k" parses as an amount

Today: `price-amount.ts` `TOKEN_RE` requires the `k|mm|m|mil` suffix glued to the number, so
"500 k" yields `none` → `no_single_amount` → fair-price reply + alert, with no value comparison.

Change: accept a single optional space before `k` only (`500 k`, `$500 k`). `m`, `mm`, `mil` stay
glued (a spaced "m" is too easily minutes/miles). `AREA_AFTER` must still reject "2 k sq ft".
`RANGE_RE` already tolerates whitespace before a magnitude suffix (`price-amount.ts:53`): leave it
unless a test proves a change is needed. The gap is token extraction only (`:43`).
Tests: spaced-k single, with `$`, "150 k to 170 k" stays a range, bare area rejection ("2 k sq ft"),
dollar-prefixed area rejection ("$2 k sq ft" must NOT fall back to reading `$2` as money — optional
suffix backtracking), and every existing extractor test unchanged.

### F5 — "Ok" after a no sends nothing

Today: order row 19 (`just_ok` → `book_appointment`, "Okay alone always = yes", Jarrad 2026-10-30)
fires even when our last text was the approved not-interested reply, whose wording asks permission
to check back. The seller then gets the said-yes reply and the Book appointment drip.

Evidence (read-only prod replay, 2026-11-10): 12 decisions that day were `book_appointment` won
by row 19 (`provenance.signal = just_ok`); for 9 of them our previous outbound text in the
conversation was exactly the approved not-interested reply (0 with a footer variant). Those 9 are
what this guard changes; the other 3 keep today's behaviour.

Design constraint (Astra r1 #1, r2 #1): there is no inert path for an inbound. The webhook pauses
the property's enrollments (`pause_reason = inbound_reply`, `messaging/inbound.ts:990-1016`) BEFORE
dispatch, and an empty-step action still reaches the transition RPC, which retires enrollments.
A "do nothing" branch would leave the drip paused forever or retired. So F5 does not add a no-op;
it reuses the path a second "no" already takes today, minus the reply.

Change, in `classifyV2` only, mirroring `isAfterRepairsReply`:
- New pure helper `isAfterNotInterestedReply(ourLastText)`: exact match (trimmed) against
  `v2ReplyText("not_interested")`, plus the same `OPT_OUT_PHRASES` footer variants. Never fuzzy.
- When the effective decision's road is `book_appointment` AND its provenance is Jev row 19
  (`signal === "just_ok"`) AND the helper is true → the action becomes
  `{ road: "not_interested_drip", steps: [drip "Not interested"] }`: the existing Not interested
  drip step only. No reply step, no alert step, no hold. This is `V2_ROAD_ACTIONS.not_interested_drip`
  with its reply step removed; build it from that table entry (filter out `kind === "reply"`), do not
  hand-write a second copy.
- Effect: the normal, already-tested transition runs. The paused enrollment is retired and the
  seller is enrolled on Not interested again, exactly as happens today when a seller says "no" a
  second time. The follow-up schedule restarts from this text. Nothing is sent now.
- No new road label, live-step kind, migration, or completion mechanism (this removes r2 #2).
  The audit row stays distinguishable: `jev_road = book_appointment`, `provenance.signal = just_ok`,
  `road = not_interested_drip`.
- Order table, cutoffs and row 19 itself are NOT changed. Any other yes signal at cutoff
  (`open_to_selling`, `asked_offer`, `future_action`) wins before row 19 and is unaffected: "Yes I'd
  sell" after the check-back text still books.
- Does not apply when a Haiku decision, hold, or repairs follow-up already replaced the action.
- First-send timing, verified read-only in prod 2026-11-10 (Astra r3 #1): sequence
  `e81e7e42-cb22-493f-8a53-67a7921b9fb2` "Not interested (routing v2)", `routing_v2_version` 1,
  step 0 `delay_after_previous_minutes` = 129600 (90 days). Not an immediate send. Re-check the
  same row immediately before merge; if step 0's delay is 0, stop and report.

## Not doing

- No flags: each fix is a narrow guard; rollback is a revert. No migration.
- No change to `possible_stop`, `haiku_unsure`, `named_price` semantics, cutoffs, or question text.
- The legacy (`pre_gate:skipped:already_terminal`) hot-text path is untouched.
- Jev misreads found in the audit (time expressions read as call requests, "I'll let you know" read
  as a future action) are reported to the owner separately; no rule change here.

## Tests (synthetic wording only — no real seller text in git)

- F1: `reply_repeat` not queued for `not_interested`; still queued for another key.
- F2: loader skips `metadata.keyword="stop"`; still alerts on a non-keyword body; drain unchanged.
- F3a: lead reply skipped when a pending/sent v2 alert row exists; NOT skipped when the only v2 alert
  row is cancelled; lookup error → skipped this pass, `complete=false`.
- F3b: for BOTH `reply_failed` and `reply_repeat`: skipped when a sent or non-conditional pending
  alert exists; repeated yes with time-only OFF → conditional `hot_yes` covers, no second alert;
  repeated yes / failed reply with time-only ON → `hot_yes` does not cover, the alert IS queued
  (failure-before-alert-delivery case); queued when no other alert; coverage lookup error → "error";
  callers treat `skipped` as done: assert the hold-written RPC runs on `"skipped"` and does NOT run
  on a coverage-lookup or flag-read `"error"` (Astra r3 #3).
- F4: as listed.
- F5 unit: just_ok after the not-interested reply → action road `not_interested_drip`, steps are
  exactly one drip step; just_ok after any other text → today's book action; open_to_selling after
  the not-interested reply → today's book action; Haiku-replaced / held / repairs cases untouched.
- F5 DB integration, entering through the inbound webhook (so the `inbound_reply` pause really
  happens): a property with an active Not interested enrollment gets the acknowledgement. Afterwards:
  exactly one active Not interested enrollment with a future `next_run_at`, none left paused as
  `inbound_reply`, no reply outbox row, no alert outbox row, no hold, no Book appointment enrollment.
  Replaying the same inbound changes nothing. Also assert the persisted decision row (Astra r3 #2):
  `road = not_interested_drip`, `jev_road = book_appointment`, provenance still row 19 / `just_ok`.
- Existing suites green: `routing-v2.test.ts`, `alert-on-time-only.test.ts`, `transition-plan.test.ts`,
  hold-alerts tests, `tsc`, lint.

## Acceptance (replay of 2026-11-10, read-only, after deploy)

Of that day's 36 alerts, these would not have fired: 9 repeat-no, 1 unmatched STOP, 1 duplicate
lead reply, 1 duplicate reply-failed (12 total). The unmatched "Wrong #" still fires. The 9 sellers
in the F5 evidence above would have received nothing and been kept on the Not interested drip. All call-me alerts
and every lead reply still fire. Verification after deploy is a read-only query over the following
day's `hold_alert_deliveries` / `routing_v2_live_decisions`, not a re-run of any classifier.

## Review asks for Astra

1. Is any fix able to lose an alert the owner decision says he must get (lead reply, call-me, hot yes
   with time-only off, haiku_unsure, possible_stop, reply_failed with no other alert)?
2. F3b: can "skipped" strand a `hold_pending` row or loop the sweep?
3. F5: does a drip-only `not_interested_drip` action run cleanly through the transition after the
   webhook's `inbound_reply` pause, ending in one active Not interested enrollment and no send?
4. F2: is skipping carrier STOP safe given phone-level opt-out already ran?

Round 3 (Astra, gpt-6-astra, 2026-11-10): **APPROVE_PLAN: YES, BLOCKING: 0.** Its three follow-ups
are folded in above.

Round 2 (Astra): NO, 1 blocking (the webhook's `inbound_reply` pause strands a no-op). F5 is
redesigned to reuse the existing not-interested drip transition instead of a no-op; r2 #2 no longer
applies; r2 #3 folded into F3b.

Round 1 (Astra, 2026-11-10): NO, 3 blocking. This revision resolves #1 (F5 no-op bypasses the
destructive transition), #2 and #3 (coverage rule shared by `reply_failed` and `reply_repeat`), and
folds in follow-ups #4–#7.

Reply with `APPROVE_PLAN: YES|NO`, then `BLOCKING: <n>` and numbered findings.
