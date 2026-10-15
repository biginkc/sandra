> **Repo copy (2026-10-14).** Behavior spec at `./unified-queue-behavior-spec.html` (referred to below as `index.html`). Astra verdicts referenced below as `astra-verdict-N.md` are at `./reviews/astra-unified-queue-round-N.md`; earlier design versions v2–v4 are in `./reviews/`. Astra round 4 verdict: `APPROVE_PLAN: YES`, `BLOCKING: 0`. Content below is verbatim from the approved v5.

# Sandra My Leads: one work queue — design v5 (behavior spec) and build plan

Prepared 2026-10-14 by Claude Fable 5.1. Supersedes v3. v3 resolved Astra round 1 (`astra-verdict-1.md`); v4 resolved round 2 (`astra-verdict-2.md`); v5 resolves the single blocker of round 3 (`astra-verdict-3.md`). Resolution tables are in sections 11, 12 and 13. Claims were re-verified against source before changes. Based on independent source inspection of `origin/main` at `011ac8a1`, read-only production queries, and a walkthrough with Jarrad in which every rule below was decided. The clickable behavior spec is `index.html` in this folder (served at `localhost:8765` during the session). **The mockup is a behavior spec, not a visual design: the real page is built from Sandra's existing components, tokens and icon set.**

No code, data, flags or messages were changed. This document requests review for implementation planning; it does not authorize a build, pilot or release.

---

## 1. The one rule: whose move is it?

Every lead in a rep's queue is in exactly one of three places:

| Place | Meaning | Tab |
|---|---|---|
| **Your move** | The rep can and should act now | **Needs attention** (default) |
| **Their move** | The ball is with the seller or with automation; nothing to do | **Waiting on them** |
| **Neither** | Under contract with nothing due | **All leads** only |

All leads shows everyone with labels. Needs attention and Waiting on them are disjoint. The safety rule that makes "Waiting" trustworthy: **anything that is not a healthy, committed future event is Your move.** A drip paused for any reason a person must fix, a text that never sent, a cancelled callback, an unknown or unverifiable automation state: all land in Needs attention, never in Waiting. Jarrad's acceptance test: he should only need to open Waiting on them about once a week, and nothing can go stale there.


### 1.1 Placement decision table (exhaustive, ordered; first true row wins)

Evaluated per lead in the rep's queue (same scope as `my_leads_queue_rows`: assigned, open episode, not deleted/archived/closed/dead/DNC-locked). `now` is the request time. "Seller-facing outbound" = any outbound message to the seller: human text, human-approved draft, AI reply, auto template, drip text, campaign text, Norma pre-call text. "Human text" = outbound with no `metadata.generated_by`, or `metadata.approved_by_user_id` set (a held draft sent/edited by a rep through messages-v2); never a campaign or drip row.


**Commitment predicate (used by rows 1, 4, 9, 11).** An *active appointment* is a `tasks` row with `next_step_kind='appointment'` and `status in ('open','snoozed')`; its *effective time* is `greatest(due_at, coalesce(snoozed_until, due_at))` (same rule as today's next-step projection). An *offer-chain task* is an active appointment whose `calendar_chain_id` equals the pending offer's `follow_up_calendar_chain_id`; it is never a callback for rows 4, 9 or 11 and is handled only by rows 8 and 12. Snooze therefore moves a callback's time, it never removes it.

**Rep to-do precedence.** A manual queued rep text (`messages.status='queued'`, `scheduled_for is null`) is unfinished rep work: it is checked at row 6a, before any Waiting row, so a future callback or healthy drip cannot hide it.

| # | Row (first match wins) | Place · reason | Notes |
|---|---|---|---|
| 1 | Stage `under_contract` and no active appointment (commitment predicate) with effective time `<= now + 15 min` | **Neither** (All leads only) | Under contract never falls into Gone quiet / Nothing planned |
| 2 | Pin active (`pinned_at` set, no attempt/outbound call after it, not cleared) | **Your move · Call today** | pins no longer expire (section 6, Phase B migration) |
| 3 | Stage `not_contacted` and no attempt | **Your move · New lead** | "first call overdue" appended when the existing episode-based working-hours deadline has passed |
| 4 | Active appointment, not an offer-chain task, with effective time `<= now + 15 min` and `>= now - 7 days` | **Your move · Due** | "Due soon" while effective time `> now`. Older than 7 days → row 9 |
| 5 | Unhandled inbound (section 5; handling is evaluated per inbound, and an accepted text keeps handling the inbound it answered even if it later fails delivery) | **Your move · New reply** | overrides any automation; a newer inbound Y after a failed-delivery text is unhandled and shows here |
| 6 | Any unresolved Broken condition (section 2.1, with the supersession rule) | **Your move · Broken** | reached only when no unhandled inbound exists; "text didn't deliver" shows here after an accepted text fails and no newer reply arrived |
| 6a | Manual queued rep text with no schedule | **Your move · Nothing planned** (label "Text waiting for you to send") | rep to-do; outranks every Waiting row |
| 7 | Stage `needs_offer` and no pending offer | **Your move · Offer** | |
| 8 | Stage `offer_sent`, pending offer, effective follow-up `<= now + 15 min` **or** follow-up missing (chain exists, no open task) | **Your move · Offer** | "follow-up due" / "follow-up missing". Effective follow-up = open chain task `due_at`; legacy no-chain offer uses `acquisition_offers.follow_up_at` |
| 9 | Active appointment (not offer-chain) with effective time older than 7 days (missed callback) | **Your move · Due** | bold line "Due · callback 9 days overdue" |
| 10 | Healthy automation (section 3.1) | **Their move · In a drip** | |
| 11 | Active appointment, not an offer-chain task, with effective time `> now + 15 min` | **Their move · Callback booked** | a lead with both a callback and an offer follow-up shows the earlier of the two as its bold line; chip = the earlier one's kind |
| 12 | Stage `offer_sent`, pending offer, effective follow-up `> now + 15 min` | **Their move · Offer out** | |
| 13 | Last seller-facing outbound is a human text or campaign text (not a drip text), accepted/sent/delivered, within 3 business days, and no inbound after it | **Their move · Texted last** | 3 business days = Mon–Fri in America/Chicago, counted from the send timestamp; a Friday 4 PM text comes back Wednesday 4 PM |
| 14 | Row 13 but older than 3 business days; or last seller-facing outbound is the final text of a `completed` (not cancelled) enrollment with no inbound after it | **Your move · Gone quiet** | a later human text, booked callback, offer, or new enrollment makes rows 10–13 true first, so a completed drip never resurrects |
| 15 | Everything else | **Your move · Nothing planned** | includes: `norma_call` pause with no open Norma request; `paused:manual` / `appointment_booked` with no active task / `person_took_over` / `terminal_dispo`; `completed` or `opted_out` enrollment with a later note; contact-only or ambiguous inbound attribution (label "check texts") |

Labels that never change placement: "Norma calling" (open `norma_call_requests` in requested/dispatching/dispatched/dispatch_unknown, calling queues are exempt from the automation rule by decision), "No phone", "Do not contact", "Opened from lead page".

Invariant tests: every queue lead matches exactly one row; row counts per tab/chip sum to the tab total; a lead in Waiting always has a concrete future event or a timer (next_run_at, scheduled_for, due_at, follow-up, or texted-at + 3 business days) shown on the row.

**Not contacted / Contacted / Needs offer / Offer sent / Under contract** remain the stage model, stored and moved exactly as today (`acquisition_queue_states.stage`; no inbound path writes it). Stage is a pill on the row and a dropdown filter on every tab; it is never a section.

---

## 2. Needs attention: reasons (chips), in sort order

The chip words are the first words of the bold line on the row, always.

| # | Chip / bold line | Predicate | Leaves when | Primary button |
|---|---|---|---|---|
| 1 | **New lead** · assigned Nd ago, not called yet [· first call overdue] | stage `not_contacted`, no attempt. "First call overdue" appends when the existing working-hours deadline (`first_call_overdue` warning) has passed | first attempt logged | Call |
| 2 | **Call today** · you pinned this at 8:05 AM | pin active (`my_leads_strip_overrides.pinned_until`). **No midnight expiry** (change from today) | call/attempt logged after `pinned_at`, or Undo (`clear`) | Call |
| 3 | **Due** · callback 2:30 PM / appointment / callback 9 days overdue | open non-offer appointment task `due_at <= now + 15 min` ("Due soon" while in the future); overdue > 7 days stays here as a missed callback | task held/no-show/rescheduled/cancelled | Call |
| 4 | **New reply** · today 9:12 AM | latest inbound text or missed call with no handling event after it (section 5). Drip or not. Overrides automation | handling event | Reply |
| 5 | **Broken** · drip couldn't send text 2 of 4 / follow-up text not sent / text didn't deliver / AI reply needs your OK | enrollment paused with a fix-needed reason; `rep_sms_obligations` in required/draft/blocked/failed/unknown; human send later `delivery_failed`; pending `ai_reply_drafts` or dead letter | retry/resume/stop/send/discard | Fix (context) |
| 6 | **Offer** · you marked them ready 2 days ago, no offer logged / follow-up due 9:00 AM / follow-up missing | stage `needs_offer` with no pending offer; or `offer_sent` + pending offer with effective follow-up `<= now + 15 min` (one boundary, same instant Waiting · Offer out ends) or chain present but no open chain task | offer logged; follow-up task held/rescheduled; offer leaves pending | Log offer / Call |
| 7 | **Gone quiet** · no reply in 3 days / drip finished Oct 1, no reply in 13 days | decision rows 13→14: last seller-facing outbound was a human/campaign text older than 3 business days with no inbound since; or the last seller-facing outbound was the final text of a completed drip with no inbound since | any newer human text, booked callback, offer, or enrollment (rows 10–13 win) | Set drip |
| 8 | **Nothing planned** (catch-all) | decision row 15 | same as 7 | Set drip |

Sort: by reason rank, then within reason: pins newest first; due by `due_at`; replies newest first; broken by failure time; offers oldest first; gone quiet / nothing planned by last touch ascending (oldest first). Final tie-break property id. Chip counts come from the same function as the rows.


### 2.1 Broken inventory (exact states)

| Source | States that are Broken | Bold line | Fix button |
|---|---|---|---|
| `sequence_enrollments.paused` | `provider_failed`, `reconciliation_required`, `no_phone`, `template_missing`, `step_misconfigured`, `consent_unavailable`, no-approved-sender reason | Broken · drip couldn't send text N of M | Fix drip (retry step / stop drip) |
| `sequence_enrollments.active` | step claim `attempt_outcome='unknown'` with `attempt_started_at` older than 15 min; or `next_run_at` more than 60 min in the past | Broken · drip is stuck | Fix drip |
| `rep_sms_obligations.state` | `required`, `draft`, `failed_not_dispatched` → Send text; `delivery_failed` → Resend; `blocked` → Review; `unknown`, and `claimed`/`sending` past `lease_expires_at` → Check status | Broken · follow-up text not sent / didn't deliver / status unknown | Send text / Resend / Review / Check status |
| `rep_sms_delivery_ledger.state` (generic manual rep sends; only acquisition reps write it) | `failed_not_dispatched`, `delivery_failed` → Resend; `blocked` → Review; `unknown`, `reserved`, `sending` older than 15 min → Check status | Broken · text didn't send / didn't deliver / text status unknown | Resend / Review / Check status |
| `messages` outbound | human text within the last 7 days with no later accepted human text and `status='failed'`: if `metadata.providerOutcome='provider_unknown'` → **unverified** (Check status); otherwise definitive → Resend. `status='pending'` older than 15 min (the sweep marks it failed-unknown) → Check status. `status='queued'` with `scheduled_for` more than 30 min in the past (campaign row never drained) → open campaign | Broken · text didn't send / text status unknown / scheduled text overdue | Resend / Check status / open campaign |
| `ai_reply_drafts.status='pending'`, `ai_reply_dead_letters` | pending draft; dead letter unresolved | Broken · AI reply needs your OK / AI reply failed | Review |
| Norma | `norma_call_requests.status='needs_review'` | Broken · Norma call needs review | Review |

`accepted` (provider accepted, delivery unconfirmed) counts as sent. `delivered` is certain. Nothing in `queued`, `pending`, `reserved`, `sending`, `unknown` counts as sent.

**One send outcome per submission.** Before choosing Broken's action, transport (`messages.status` + `metadata.providerOutcome`) and ledger/obligation state are normalized into one outcome: `sent` (`sent`/`delivered`, ledger `accepted`/`delivered`), `unverified` (ledger `unknown`/`reserved`/`sending` stale; obligation `unknown`/stale lease; transport `failed` with `providerOutcome='provider_unknown'`; transport `pending` stale), `failed` (ledger `failed_not_dispatched`/`delivery_failed`; obligation `failed_not_dispatched`/`delivery_failed`; transport `failed` without `provider_unknown`), `blocked`. Only `failed` ever gets the new-key Resend; `unverified` always gets Check status (existing reconciliation), including manual sends with no ledger receipt (the lead-page non-acquisition branch writes no ledger).

**Supersession and resolution (a failure is Broken only while unresolved).** A failed submission (ledger `failed_not_dispatched` / `blocked` / `delivery_failed`, obligation failed states, a failed human `messages` row) is *resolved* when any of these exists after its failure time on the same property: a later accepted/sent/delivered human text (a replacement, under any submission key); the same obligation reaching `accepted`/`delivered`/`voided`/`exception_closed`; a user `my_leads_workflow` or `dispo_set` event; a user-created next step or rep-started drip; or an explicit "Dismiss" on the Broken row (writes a `lead_events` row `rep_sms_failure_dismissed` with the ledger/obligation id). Resolved failures never show. `unknown`, `reserved`, `sending` older than 15 min are *unverified*, not failed: bold line "Broken · text status unknown", action **Check status** (existing reconciliation; never a blind resend). Definitive failures get **Resend** (opens the composer with the body prefilled, new submission key). `blocked` gets **Review** (shows the block reason). Tests: fail → replacement under a new key clears it; fail → no-answer call does not clear it; unknown → reconciled to delivered clears it; unknown → reconciled to failed becomes Resend; manual send without ledger receipt stored `failed` + `provider_unknown` → Check status, never Resend; same, reconciled to delivered → Texted last; same, reconciled to definitive failure → Resend.

Removed on purpose: **Not today** (hide until midnight) and its "Hidden today" count. Set drip does that job now. Call next's tier "everyone else by oldest touch" is gone; a lead must have a reason to be here.

---

## 3. Waiting on them: states (chips)

| Chip / bold line | Predicate |
|---|---|
| **In a drip** · Warm check-in · starts Thu 10:00 AM · text 1 of 4 / text 2 of 4 sent Mon · next Fri 10:00 AM | see 3.1 |

### 3.1 Healthy automation (the only thing that earns "In a drip")

- `sequence_enrollments.status='active'` with `next_run_at` not null, `next_run_at` not more than 60 min in the past, and no step claim with `attempt_outcome='unknown'` older than 15 min; or
- `status='paused'` with `pause_reason='call_in_progress'` and `updated_at` within 30 min (the sweep resumes these at 30 min; older ones are Broken · drip is stuck); or
- a campaign/bulk `messages` row `status='queued'` with `scheduled_for` in the future or within the last 30 min (label "Text scheduled Oct 16 9:00 AM"; 0 rows in prod today).

**`norma_call` is not healthy.** Verified: `fn_norma_release_pauses` resumes only after a final `no_answer` on an eligible lead; every other outcome (callback_requested, reached_no_callback, not_interested, wrong_number, unknown, reviewed) keeps the enrollment paused as `norma_call` with no sweep. So `norma_call` is treated like `manual`: the next move is a person's, and the lead falls through the decision table (usually to Due via the callback Norma booked, or Nothing planned).

Not healthy, never In a drip: `paused` with `inbound_reply`, `rep_sms_human_takeover`, `norma_call`, `manual`, `appointment_booked`, `person_took_over`, `consent_unavailable`, `terminal_dispo`, `template_missing`, `step_misconfigured`, `no_phone`, `provider_failed`, `reconciliation_required`, no approved sender; `completed`; `opted_out`. Enrollment exclusions apply to the In a drip state only; a lead with a paused-by-reply enrollment can still be Texted last, Callback booked, or Offer out once the rep has acted.

| **Texted last** · you texted 3h ago | decision row 13: last seller-facing outbound is a human text or campaign text (not a drip text), accepted/sent/delivered, within 3 business days, no inbound since |
| **Offer out** · offer follow-up Oct 20 9:00 AM | stage `offer_sent`, pending offer, effective follow-up (open chain task `due_at`, or legacy `follow_up_at` when no chain) `> now + 15 min` |
| **Callback booked** · Thu 10:00 AM | open appointment task with `due_at > now + 15 min` |

Sort: next event time ascending (next text, follow-up, callback), then last touch. Long nurture drips (14/30/60/180-day gaps) sit here legitimately; the row shows the next text date so it is not mistaken for stale.

Excluded from In a drip: see 3.1. Seller appointment reminders hang off a booked callback and are not a state. Manual queued rep texts with no schedule are the rep's to-do (Nothing planned, label "Text waiting for you to send").

---

## 4. The row

**Collapsed (default):** slot icon · name · stage pill · full address (street, city, state, zip) · **bold reason line** (color by reason) · two buttons: the reason's primary + **Open lead**. Border color = stage color (Not contacted blue, Contacted teal, Needs offer orange, Offer sent purple, Under contract green). Click anywhere on the row to expand; ⤢ in the tab bar expands/collapses all.

**Slot icon (left of name), one of five, priority order:**
1. 💬 New reply not answered
2. ⚠️ Something broke
3. ✨ New lead, never called
4. 💧 In a drip (healthy)
5. drip-with-X: not in a drip

(Emoji stand in for Sandra's icon set.)

**Expanded adds labeled lines**, one fact per line: DRIP (which drip, where it stopped, why: "Seller follow-up · stopped at text 2 of 4 — they replied"; running with next date; finished; couldn't send; none) · NEXT STEP (booked callback/appointment or none) · LAST TOUCH (what and how long ago) · ATTEMPTS (count · assigned Nd ago) · MOTIVATION (hot/warm/cold + reason) or PHONE warning (no phone / do not contact). CLEARS line only on Call today.

**Conversation box** (every lead with texts): last outbound and last inbound, newest at the bottom, one line each, "Us" tagged "(drip)" when automated, unanswered reply in blue; "Show all texts" opens the full thread with the composer (existing text strip). No "They said" line.

**Expanded buttons, two columns:** [reason primary, full width when not Call] · Call · Log attempt · Call today · Set drip · Open lead · More ⋯.
**More ⋯** (stage-aware, same commands as today): Text, Ready to make an offer, Log offer, Schedule a callback, Contract signed, Offer declined, Dead / Nurture, Call with coach, Open in Zillow, Archive (under contract only).

**Details** are not on the row; they live on the lead page via Open lead. Verified gap: the lead page already shows attempts, offers, notes, calls, the text thread and a composer, but lists only open `type='appointment'` tasks and the single nearest next action. Before the in-row panel is retired, Phase B adds lead-page parity: an Appointments section listing all statuses (open, snoozed, completed, cancelled, past) and every callback, with the same Held / No-show / Reschedule / Cancel / Done / Snooze actions and the same assignee-or-owner rule; the no-answer text follow-up status on each attempt; and assignment-episode history. The in-row panel is retired only after that lands.

**Conversation box → "Show all texts"** opens an in-row thread built from the existing pieces: the text history strip (`sms-strip.tsx`, history only) plus the existing `RepSmsComposer` (placement "action") beneath it, carrying the reply-to stamp. This is a composition of existing components, not a new surface.

---

## 5. Handled-reply rule (single definition for rows, counts, badge)

The latest inbound text on the property (by `property_id`, or by homeowner contact when `property_id` is null, as today's touch SQL does) or missed inbound call is **unhandled** unless, after it (ordered by `(created_at, id)`), one of these exists:

| Handling event | Authoritative fields | Counts? |
|---|---|---|
| Human text, affirmatively sent | `messages` outbound, no `campaign_id`, no `sequence_step_runs` row, and (no `metadata.generated_by` **or** `metadata.approved_by_user_id` set); `status in ('sent','delivered')` or ledger `accepted`/`delivered`. A text that was accepted and later `delivery_failed` still counts as handling the inbound it answered, and raises Broken once no newer unhandled inbound exists (decision rows 5 then 6) | Yes |
| Auto-sent library template | `metadata.reply_source='approved_template'` with no `approved_by_user_id` | **No** (it is an AI reply) ⭐ pending Jarrad |
| Held draft sent or edited by a rep (messages-v2) | `metadata.approved_by_user_id` set, `ai_reply_drafts.status='sent'` | Yes |
| Logged attempt | `acquisition_attempts` with `outcome='reached'`, by `recorded_at` | Yes ⭐ pending Jarrad; `no_answer`, `voicemail`, `wrong_number`, `not_logged` do not count |
| User disposition / workflow | `lead_events` with `actor_type='user'` and `event_type='dispo_set'`, or `my_leads_workflow` with operation in the existing allowlist | Yes |
| Next step booked by the rep | `lead_events` `appointment_booked` / `task_created` with `actor_type='user'` (not `tasks.created_by`, which Norma can set) | Yes |
| Rep-started drip | `sequence_enrollments.enrolled_by_user_id` set, `enrolled_at` after the inbound; AI routes (`auto_enrolled_route` set, null enroller) do not count | Yes |
| Note, opening the lead, AI reply, failed/queued/pending/unknown send, system event, no-answer call | | Never |

**Reply-to stamp (concurrency).** Human sends from the My Leads composer and the lead-page/Inbox composer carry an optional `inboundMessageId`, stamped as top-level `metadata.inbound_message_id` (the AI convention). Contract:
- The composer captures the newest inbound shown when it opened; the value is preserved across obligation resume, durable-draft recovery and retries (`claim_generation` bumps keep it).
- The server validates the referenced message is inbound, same org, same property or conversation; otherwise it drops the stamp and falls back to time ordering.
- A stamped text handles reply X only if the referenced inbound's `(created_at, id)` is >= X's. A reply newer than the stamp stays unhandled. Ordering uses the referenced row's timestamp, never UUID comparison.
- Unstamped legacy texts and all coarse events (attempts, dispositions, next steps, enrollments) use `(created_at, id)` ordering only. Missed calls have no stamp; they are handled by any qualifying event after them. The seconds-wide race on coarse events is accepted; the row always shows the newest reply time and refreshes every 30 s.
- Threading points (verified): `DispatchRepSmsInput` + `dispatchRepSms` (`src/lib/messaging/rep-sms.ts`), `PublicSendRepSmsInput`/`safeDispatchInput`, `sendRepSms`, `resumeRepSms` (`src/app/(dashboard)/my-leads/sms-actions.ts`), `RepSmsComposer`, `sendSmsFromLead` (`src/app/(dashboard)/leads/actions.ts`, both branches: `dispatchRepSms` and `sendSmsToContact({metadata})`), `InlineReply` and its callers on the lead page and `messages/inbox-detail.tsx`, `LeadRepSmsComposer`.
- Tests: X then Y arrival while composing; reload and resume with the stamp intact; legacy unstamped text after X; cross-property stamp rejected.

No new handling table.

## 6. Page chrome

- **Tabs:** Needs attention (default) · Waiting on them · All leads, each with a live count. Right end of the tab bar: ⤢ expand/collapse all, 🔍 search (box hidden until clicked; searches name, address, phone within the current tab and chip).
- **Chips** under Needs attention (order: New lead, Call today, Due, New reply, Broken, Offer, Gone quiet, All reasons) and under Waiting (In a drip, Texted last, Offer out, Callback booked, All waiting). All reasons is selected on open; new leads are always on top so no "New lead default" is needed.
- **Stage dropdown** on every tab with counts; stacks with chips and search.
- **Pagination: page numbers, 25 per page**, page in the URL. Load more is removed. Contract:
  - **Two reads, one snapshot.** `fn_my_leads_work_page(member, tab, chip, stage, search, page, size, at)` returns, from a single statement: the page's row ids in order, the total, the tab/chip counts, and a `revision` = hash of the full ordered id list of the eligible set for that tab (membership and order), plus `next_change_at` = the earliest future instant at which any lead's placement changes by the clock alone (next `due_at`/effective time − 15 min, next texted-at + 3 business days, next `next_run_at` + 60 min, next pin/offer boundary), computed the way today's `nextWarningAt` is. `fn_my_leads_work_facts(ids[])` returns current facts for any ids (used for retained rows).
  - **Refresh (every 30 s, and at `next_change_at`):** re-run the page read with the same page number. If `revision` is unchanged → replace row facts in place. If changed → keep the currently displayed ids in place, fetch their facts via `work_facts` (so retained rows that moved off the page still update), and show "List updated · Refresh" with the new counts; "Refresh" swaps in the new page.
  - **After the rep acts on a row** (reply sent, call logged, drip set, next step booked, dismiss): fetch that lead's facts; if its new placement is outside the current tab+chip, remove the row with a one-line notice ("Moved to Waiting on them"); otherwise update it in place (e.g. a no-answer call with New reply still open keeps the row). Then re-run the page read for counts.
  - Page clamps to the last page when the total shrinks; tab/chip/stage/search change resets to page 1; each response carries the request sequence and stale responses are dropped; a deep-linked lead is pinned at the top regardless of page; the 30 s timer pauses while a composer or dialog is open on the page, like today.
  - Tests: insertion and deletion above page 2; callback crossing the due boundary with no writes (clock-only, caught by `next_change_at`); a text crossing 3 business days; a reply arriving while a composer is open on page 2; last page shrinking to empty; counts vs rows under concurrent writes; no-answer action leaving the row in place; reply action removing it.
- **Sidebar badge:** number of distinct leads in the viewer's own queue whose placement row is Due, New reply or Broken (a lead counts once). Replaces the Not contacted count (0 in prod). Read through the same org-scoped wrapper as the page.
- **Call today persistence:** `my_leads_strip_overrides` has a check constraint requiring `pinned_until` (verified). Phase B adds a migration that relaxes it (`pinned_until` nullable when `pinned_at` set) and a new RPC `fn_set_my_leads_pin` (pin / clear, no expiry, member-only like today) used only by the new UI; the old RPC and its midnight writes stay untouched for the flag-off page, and its expired-row cleanup is changed to skip null `pinned_until`. The read predicate becomes `pinned_at is not null and (pinned_until is null or pinned_until > now) and no call after pinned_at`.
- **Security/scope:** every new RPC is an org-scoped wrapper over `my_leads_require_read_scope` (owner may read any rep; others only themselves); pin writes require viewer = member; search is bounded to 200 chars and pages to 1–50; negative tests for cross-org and other-rep access.
- **`comp_queue`:** server-side selection of the top 10 of the Needs attention order for the member, independent of the visible page or filters; gated by the same flag as the page.
- Kept unchanged: callback-due banner and notification, post-call prompt and auto-prompt, owner rep selector and view-vs-act scope, Manage Acquisitions, RepSmsSettings, daily call clock, deep links (`?lead=` pins the row in whichever tab it belongs to), unavailable-lead reasons, error banners, `comp_queue` enqueue (re-pointed to the top 10 of Needs attention).

---

## 7. Automation producers (inventory gate, from source)

| Producer | Future send committed when | Reply pauses it? | Treatment |
|---|---|---|---|
| Drip (`sequence_enrollments` + `sequence_step_runs`) | `active` with `next_run_at`; `paused:call_in_progress`/`norma_call` | Yes for `active` rows via `pausePropertyEnrollments`; **not** when inbound attribution is ambiguous (`no_property`) | Waiting · In a drip when healthy |
| Campaign/bulk queue (`messages.queued` + `scheduled_for`) | queued with schedule | **No** | Waiting · In a drip only while no unhandled reply (reply ⇒ Your move) |
| Manual queued rep text (`queued`, no schedule) | never auto-sends | n/a | Your move, label "Text waiting for you to send" |
| Seller appointment reminder | `pending` + `send_at` (flag off, 0 rows) | No | Not a state; rides on Callback booked |
| Rep no-answer obligation (`rep_sms_obligations`) | never; `claimed/sending` in flight | takeover | required/draft/blocked/failed/unknown ⇒ Broken |
| AI delayed reply (Workflow runtime) | inbound stamped `delayed` | superseded by newer inbound | ignored for placement (minutes) |
| AI held draft / dead letter | needs a person | n/a | Broken |
| Norma pre-call text | sent immediately | n/a | nothing |
| Calling queues (Norma, dialer) | calls, not texts | n/a | excluded; label "Norma calling" only |

The two existing "in drip" predicates disagree (My Leads: active only; Inbox: active or paused). The new classifier is the single definition for My Leads; the Inbox is out of scope.

Production shape on 2026-10-14 (Jarrad's queue, 181 leads): 36 active drip, 42 paused by reply, 2 provider_failed, 97 no enrollment (19 with an inbound in 30 days), 0 scheduled campaign texts, 0 reminders. `properties.needs_human_attention` is set on 110 of 181 and is **not** used as a reason.

---

## 8. Scenario fixtures (each is a seeded test with expected tab, chip, bold line, icon)

| Scenario | Tab · chip | Bold line | Icon |
|---|---|---|---|
| Assigned today, never called | NA · New lead | New lead · assigned today, not called yet | ✨ |
| Assigned, past first-call window | NA · New lead | New lead · … · first call overdue | ✨ |
| Rep schedules a drip, first text not sent | Waiting · In a drip | Drip starts Thu 10:00 AM · text 1 of 4 | 💧 |
| Drip running, no reply | Waiting · In a drip | Text 2 of 4 sent Mon · next Fri | 💧 |
| Seller replies while drip running | NA · New reply | New reply · 9:12 AM (Drip: paused at text 2 of 4 — they replied) | 💬 |
| Rep texts back (own text, or a held draft they approved), send accepted | Waiting · Texted last | Texted last · you texted 2m ago | drip-X |
| Auto-sent library template replies to the seller | NA · New reply (still) | New reply · 9:12 AM | 💬 |
| Rep's reply fails to send | NA · New reply (still) + Broken label | New reply · 9:12 AM | 💬 |
| Reply Y arrives while rep is sending for X | NA · New reply (Y) | New reply · Y time | 💬 |
| Note / open lead / AI auto-reply / call with no answer, voicemail or wrong number | NA · New reply (still) | unchanged | 💬 |
| Rep's accepted reply later fails delivery | NA · Broken | Broken · text didn't deliver | ⚠️ |
| Rep logs a reached call after the reply | leaves New reply → Nothing planned unless next step | | drip-X |
| Rep books a callback after reading the reply | Waiting · Callback booked | Waiting on them · callback Thu 10:00 | drip-X |
| Rep starts a drip after reading the reply | Waiting · In a drip | | 💧 |
| Callback due while drip active (external task) | NA · Due | Due · callback 2:30 PM (Drip line shows running) | 💧 |
| Future callback later today | Waiting · Callback booked | | |
| Drip `provider_failed` | NA · Broken | Broken · drip couldn't send text 2 of 4 | ⚠️ |
| Drip completed, no reply | NA · Gone quiet | Gone quiet · drip finished Oct 1, no reply in 13 days | drip-X |
| Rep texted, silence 3 business days | NA · Gone quiet | Gone quiet · no reply in 3 days | drip-X |
| Rep texted 3h ago | Waiting · Texted last | | drip-X |
| Single scheduled campaign text, queued | Waiting · In a drip | Text scheduled Oct 16 9:00 AM | 💧 |
| Same, after it sent, no reply | Waiting · Texted last → Gone quiet after 3 business days | | drip-X |
| Campaign row queued, `scheduled_for` 45 min ago, still queued | NA · Broken | Broken · scheduled text overdue | ⚠️ |
| Drip completed, then rep booked a callback | Waiting · Callback booked | | drip-X |
| Drip completed, then rep sent a text 1 day ago | Waiting · Texted last | | drip-X |
| Pending offer, chain task completed, no successor | NA · Offer | Offer · follow-up missing | |
| Offer follow-up at −16 / −15 / −1 / 0 min | Waiting · Offer out / NA · Offer (Due soon) / NA · Offer / NA · Offer | | |
| Norma call ended callback_requested (drip paused `norma_call`, callback task created) | Waiting · Callback booked, label Norma | | drip-X |
| Norma call ended wrong_number (drip paused `norma_call`, custom task) | NA · Nothing planned (label: Norma task) | | drip-X |
| Norma request still open | wherever other rows put it, label "Norma calling" | | |
| Enrollment `paused:manual` | NA · Nothing planned | | drip-X |
| Enrollment `paused:call_in_progress` 5 min / 45 min | Waiting · In a drip / NA · Broken · drip is stuck | | 💧 / ⚠️ |
| Friday 4 PM text, checked Monday 9 AM / Wednesday 5 PM | Waiting · Texted last / NA · Gone quiet | | |
| DST weekend inside the 3-day window | same results (business days, not 72 h) | | |
| Due callback and unanswered reply on the same lead | NA · Due (reply line shown; badge counts the lead once) | | 💬 |
| Owner viewing a rep | same rows, action buttons disabled except Open lead | | |
| Offer logged with chained follow-up appointment 5 days out (standard path) | Waiting · Offer out (not Callback booked) | Offer out · follow-up Oct 20 | |
| Lead with a callback Thu and an offer follow-up Fri | Waiting · Callback booked (earlier), bold line names Thu callback | | |
| Callback snoozed until tomorrow 9 AM | Waiting · Callback booked (effective time) | Callback booked · tomorrow 9:00 AM (snoozed) | |
| Snoozed callback whose snooze passed 10 min ago, drip healthy | NA · Due (overrides drip) | Due · callback 10 min overdue | 💧 |
| Manual queued text, no schedule, plus future callback / plus healthy drip | NA · Nothing planned (Text waiting for you to send) | | |
| Accepted reply to X fails delivery, then Y arrives | NA · New reply (Y) | New reply · Y time (Broken label shown) | 💬 |
| Accepted reply to X fails delivery, no Y | NA · Broken | Broken · text didn't deliver | ⚠️ |
| Reply fails at send time (never accepted) | NA · New reply (still) + Broken label | | 💬 |
| Failed text, then a replacement text accepted under a new key | Waiting · Texted last (failure resolved) | | drip-X |
| Failed text, then no-answer call | NA · Broken (still) | | ⚠️ |
| Ledger `unknown` 20 min, then reconciled delivered | NA · Broken · status unknown → Waiting · Texted last | | |
| Offer logged, follow-up in 5 days | Waiting · Offer out | | |
| Offer follow-up date arrives | NA · Offer | Offer · follow-up due 9:00 AM | |
| Ready for offer, none logged | NA · Offer | Offer · you marked them ready 2 days ago | |
| No phone | wherever its reason puts it; Call disabled; PHONE line | | |
| Contact DNC | same; Call/Text disabled; "Do not contact" | | |
| Under contract, nothing due | All leads only | Under contract · signed Oct 2 | |
| Call today pinned, then call logged | leaves Call today | | |
| Deep link to a lead in Waiting | opens Waiting tab, row pinned top | | |
| Manual queued rep text, no schedule | NA · Nothing planned | Nothing planned (Text waiting for you to send) | drip-X |
| Nurture drip, next text in 60 days | Waiting · In a drip | next text Dec 14 | 💧 |

Plus: count/list agreement per tab and chip, stage dropdown stacking, search within tab, page boundaries with refresh, DST midnight irrelevant (no midnight rules remain), 400-lead timing bound, owner viewing a rep (read-only strip semantics preserved), badge = replies+due+broken for the viewer only.

---

## 9. Decisions recorded (Jarrad, 2026-10-14 walkthrough)

- Needs attention = your move only; Waiting on them = their move; three tabs. Scheduled and In a drip are chips, not tabs.
- Gone quiet after **3 business days** of silence (default accepted unless changed).
- Call today has no midnight expiry; Undo instead. Not today removed.
- Reason chips' words match the row's bold line exactly. Order: New lead, Call today, Due, New reply, Broken, Offer, Gone quiet, All reasons (last).
- Five slot icons incl. new lead and error; motivation dot removed (motivation is a text line).
- Rows collapsible; collapsed shows reason button + Open lead only; expanded shows six buttons and labeled lines; details on the lead page.
- Conversation preview of the last exchange on every row; full address with city/state/zip; stage-colored border.
- Page numbers, 25 per page; search hidden behind an icon; expand/collapse all as one icon.
- Four attention KPI tiles replaced by tab/chip counts; badge = replies + due + broken.
- Mockup is a behavior spec; build with Sandra's components.

Pending Jarrad (defaults marked ⭐ above, asked 2026-10-14 evening): (a) auto-sent library template is not handling; (b) only a reached call clears New reply. Also open only if he objects: the 3-business-day number.

---

## 10. Build plan (after Astra approval)

**Phase A — classifier, no UI (PR 1, worktree)**
- The decision table (1.1), Broken inventory (2.1), healthy-automation rule (3.1) and handled-reply table (5) are implemented as one SQL function family; each table row is a named fixture.
- SQL `fn_my_leads_work_items(member, at, tab, chip, stage, search, page, page_size)` returning stage, place (your_move/their_move/neither), reason, reason_at, headline parts, drip status, next step, last touch, attempts, assigned_at, last inbound + handled flag, contact availability; plus `fn_my_leads_work_counts` over the same CTEs for tabs, chips and badge.
- Additive: optional `inboundMessageId` threaded through the eight send points listed in section 5, stamped as `metadata.inbound_message_id`, validated server-side. `approved_by_user_id` distinguishes rep-approved drafts from auto templates.
- Fixture tests for every row in section 8 and every decision-table row, repeated-inbound ordering, business-day and DST boundaries, cross-org/other-rep negatives, 400-lead timing (reuse the call-next integration harness). Rows+counts+revision from one statement.
- One-off read-only comparison script: for Jarrad's queue, every lead in today's Call next top ten, sections and drip section vs its new tab/chip; every lead not in Needs attention or Waiting must be explained.

**Phase B — UI behind `unified_queue` org flag (PR 2, stacked on PR 1)**
- Migration: relax the pin constraint; new `fn_set_my_leads_pin` RPC; old RPC untouched. Lead-page appointment parity (section 4). In-row thread = sms-strip + RepSmsComposer.
- Tabs, chips, stage dropdown, search, pagination, rows (collapsed/expanded), icons from Sandra's icon set, conversation box, six buttons + More, Undo for Call today, deep links, empty/error states, mobile layout.
- KPI tiles and badge per section 6 (badge and comp selection gated by the same flag); `comp_queue` selects server-side from the classifier. Old components untouched; flag off renders today's page. Flag-off regression suite (existing call-next, sections, drip, badge tests) must stay green with the flag off.
- Component tests (reason copy, button map per stage), synthetic Playwright per tab/chip/count/deep link/page refresh. Fable review, then Astra review at the same SHA.

**Phase C — enable for Jarrad**
- Rollback rehearsal first: flag on → off → on against the test project, asserting today's page returns unchanged and pins written by the new RPC are ignored by the old page. Then flag on for the org; Jarrad works it; rollback = flag off (stamps and pins are harmless). Retire PR (strip, sections, adapter drip subtraction, in-row detail panel) only after lead-page parity has shipped and at least two weeks of flag-on use with the flag-off path still green.

Out of scope: Inbox predicates, `needs_human_attention` cleanup, Messages v2, calling queues, archive browsing, multi-rep features.

---

## 11. Resolution of Astra review 1 (`astra-verdict-1.md`)

| # | Finding | Resolution in v3 |
|---|---|---|
| B1 | `norma_call` not auto-resumed | Verified. 3.1: `norma_call` is never healthy; decision rows 4/11/15 place it. Fixtures for callback_requested, wrong_number, needs_review, open request. |
| B2 | Predicates not exhaustive/ordered | 1.1 ordered decision table with first-match semantics; exclusions scoped to In a drip; newer commitments outrank completed drips; missing follow-up → Offer; campaign text counts for Texted last; invariant tests. |
| B3 | Template provenance; attempt outcomes | 5: auto template (`reply_source` without `approved_by_user_id`) is not handling; rep-approved drafts (`approved_by_user_id`) are. Only `reached` attempts clear. Fixtures fixed. Both flagged ⭐ pending Jarrad. |
| B4 | "Non-failed" insufficient; late failure precedence | 5 and 2.1: affirmative sent/delivered/accepted only; accepted-then-delivery_failed stays handling for that inbound and raises Broken when no newer unhandled inbound exists (rows 5 then 6). Fixtures for both transitions. |
| B5 | Stamp contract incomplete | 5: eight threading points, validation, preservation across resume/retry, timestamp ordering, legacy fallback, missed-call rule, tests. |
| B6 | Offer follow-up windows and chains | One boundary (`now + 15 min`) for Due/Offer and end of Offer out; chain-aware effective follow-up; missing chain task → Offer · follow-up missing; fixtures at −16/−15/−1/0 and completed chain. |
| B7 | Broken inventory incomplete | 2.1: ledger 8 states mapped, obligations, stale in-flight limits, overdue scheduled sends. |
| B8 | Details on lead page lose appointments | 4: verified gap; lead-page parity is a Phase B deliverable before retirement; in-row thread = sms-strip + RepSmsComposer. |
| B9 | Pagination contract | 6: single-statement rows+total+revision, retained rows, "List updated", clamping, resets, stale-request rejection, action removal, deep-link exception, tests. |
| B10 | Pins and rollback | 6/10: constraint migration + new RPC, old RPC untouched, badge and comp gated by the flag, flag-off regression and rollback rehearsal, two-week observation before retire. |
| N11 | Name authoritative fields | 5: field table; user-actor next-step events; contact-only inbound preserved. |
| N12 | Scope/security, business days | 6: org-scoped wrappers, bounds, negative tests; business-day/DST fixtures; episode-based first-call warning kept; badge counts distinct leads. |
| N13 | Mockup gaps | `index.html` updated: chevron handler, Call disabled on no-phone, Waiting headlines start with chip words, illustrative controls marked, Nothing planned and overlapping-reason fixtures added. |

---

## 12. Resolution of Astra review 2 (`astra-verdict-2.md`)

| # | Finding | Resolution in v4 |
|---|---|---|
| B2 | Manual queued text hidden behind Waiting rows | New decision row 6a ahead of all Waiting rows; overlap fixtures (queued text + future callback, + healthy drip). |
| B4 | Row-5 Broken exclusion too broad | Exclusion removed; handling is per inbound (an accepted text handles the inbound it answered even after a later delivery failure; a newer Y is unhandled). Row 6 is reached only when no unhandled inbound exists. Fixtures: initial failure, late failure, late failure then Y. |
| B7 | Ledger recovery/supersession missing | 2.1 supersession rule: failures are Broken only while unresolved (replacement under any key, obligation terminal states, user workflow/dispo/next step/drip, explicit Dismiss event). `unknown`/stale in-flight → "Check status" (reconciliation), never blind Resend; `blocked` → Review. Tests listed. |
| B9 | Revision/refresh contract insufficient | 6: revision = hash of the ordered eligible id list; `next_change_at` clock-boundary scheduling (mirrors `nextWarningAt`); retained rows refreshed by id via `work_facts`; acted-on rows removed only when their new placement leaves the view. Tests for clock-only transitions and the no-answer case. |
| 14 | Offer-chain tasks classified as Callback booked | Commitment predicate: offer-chain tasks are excluded from rows 4, 9, 11 and handled only by rows 8/12 (as today's `is_offer_follow_up`). Both-commitments precedence: earlier effective time wins the bold line and chip. Fixtures added. |
| 15 | Snoozed callbacks dropped | Commitment predicate uses `status in ('open','snoozed')` with effective time `greatest(due_at, snoozed_until)`, applied to rows 1, 4, 9, 11. Fixtures before/at/after snooze expiry, with a healthy drip. |
| N13 | Mockup search and icon | Search marked illustrative; the overlapping-reason fixture now shows the 💬 icon (reply-first rule). |

---

## 13. Resolution of Astra review 3 (`astra-verdict-3.md`)

| # | Finding | Resolution in v5 |
|---|---|---|
| 16 | `messages.status='failed'` can mean provider-unknown; Resend could duplicate an accepted text | 2.1: one normalized send outcome per submission; transport `failed` with `metadata.providerOutcome='provider_unknown'` and stale `pending` are *unverified* → Check status; only definitive failures get the new-key Resend; applies to manual sends with no ledger receipt. Fixtures for ambiguous manual sends with/without receipt, reconciled to delivered and to failure. Stale "row 6 outranks row 5" wording in sections 5 and 11 aligned to the ordered table. |
