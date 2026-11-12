# Sandra My Leads: one work queue — design v2 (behavior spec) and build plan

Prepared 2026-10-14 by Claude Fable 5.1. Supersedes v1 (`my-leads-unified-queue-design.md`). Based on independent source inspection of `origin/main` at `011ac8a1`, read-only production queries, and a walkthrough with Jarrad in which every rule below was decided. The clickable behavior spec is `index.html` in this folder (served at `localhost:8765` during the session). **The mockup is a behavior spec, not a visual design: the real page is built from Sandra's existing components, tokens and icon set.**

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

**Not contacted / Contacted / Needs offer / Offer sent / Under contract** remain the stage model, stored and moved exactly as today (`acquisition_queue_states.stage`; no inbound path writes it). Stage is a pill on the row and a dropdown filter on every tab; it is never a section.

---

## 2. Needs attention: reasons (chips), in sort order

The chip words are the first words of the bold line on the row, always.

| # | Chip / bold line | Predicate | Leaves when | Primary button |
|---|---|---|---|---|
| 1 | **New lead** · assigned Nd ago, not called yet [· first call overdue] | stage `not_contacted`, no attempt. "First call overdue" appends when the existing working-hours deadline (`first_call_overdue` warning) has passed | first attempt logged | Call |
| 2 | **Call today** · you pinned this at 8:05 AM | pin active (`my_leads_strip_overrides.pinned_until`). **No midnight expiry** (change from today) | call/attempt logged after `pinned_at`, or Undo (`clear`) | Call |
| 3 | **Due** · callback 2:30 PM / appointment / offer follow-up | open appointment task `due_at <= now + 15 min` (existing window; "Due soon" while in the future); offer follow-up task likewise | task held/no-show/rescheduled/cancelled; offer follow-up resolved | Call |
| 4 | **New reply** · today 9:12 AM | latest inbound text or missed call with no handling event after it (section 5). Drip or not. Overrides automation | handling event | Reply |
| 5 | **Broken** · drip couldn't send text 2 of 4 / follow-up text not sent / text didn't deliver / AI reply needs your OK | enrollment paused with a fix-needed reason; `rep_sms_obligations` in required/draft/blocked/failed/unknown; human send later `delivery_failed`; pending `ai_reply_drafts` or dead letter | retry/resume/stop/send/discard | Fix (context) |
| 6 | **Offer** · you marked them ready 2 days ago, no offer logged / offer follow-up overdue | stage `needs_offer` with no pending offer; or `offer_sent` with follow-up `due_at <= now` (same as Due but kept under Offer so the chip count means "money pending") | offer logged / follow-up resolved | Log offer |
| 7 | **Gone quiet** · no reply in N days / drip finished Oct 1, no reply in 13 days | last outbound was yours (human text, or call + no-answer text) and no inbound for **3 business days** (Mon–Fri, Central); or enrollment `completed` (not cancelled) with no inbound after the last step | drip started, text sent, next step booked, handoff, archive | Set drip |
| 8 | **Nothing planned** (catch-all) | Your move with no specific reason above: no healthy automation, no future open appointment, no pending offer, last touch not an outbound to the seller (e.g. only a note, or a call with no text), stage ≠ `under_contract` | same as 7 | Set drip |

Sort: by reason rank, then within reason: pins newest first; due by `due_at`; replies newest first; broken by failure time; offers oldest first; gone quiet / nothing planned by last touch ascending (oldest first). Final tie-break property id. Chip counts come from the same function as the rows.

Removed on purpose: **Not today** (hide until midnight) and its "Hidden today" count. Set drip does that job now. Call next's tier "everyone else by oldest touch" is gone; a lead must have a reason to be here.

---

## 3. Waiting on them: states (chips)

| Chip / bold line | Predicate |
|---|---|
| **In a drip** · Warm check-in · starts Thu 10:00 AM · text 1 of 4 / text 2 of 4 sent Mon · next Fri 10:00 AM | healthy enrollment: `active` with `next_run_at` and no step claim stuck > 15 min; or `paused` with auto-resume reason `call_in_progress` / `norma_call`. Also a campaign/bulk row `status='queued'` with `scheduled_for` set (label "Text scheduled Oct 16 9:00 AM"), while no unhandled reply exists (0 such rows in prod today) |
| **Texted last** · you texted 3h ago | last touch is a human outbound text to the seller (or call + no-answer text) and < 3 business days ago, no inbound since |
| **Offer out** · offer follow-up Oct 20 9:00 AM | stage `offer_sent`, pending offer, follow-up `due_at > now + 15 min` |
| **Callback booked** · Thu 10:00 AM | open appointment task with `due_at > now + 15 min` |

Sort: next event time ascending (next text, follow-up, callback), then last touch. Long nurture drips (14/30/60/180-day gaps) sit here legitimately; the row shows the next text date so it is not mistaken for stale.

Excluded from Waiting: paused-by-reply enrollments (`inbound_reply`, `rep_sms_human_takeover`), paused-needs-person (`manual`, `appointment_booked` without a future task, `person_took_over`, `consent_unavailable`, `terminal_dispo`, `template_missing`, `step_misconfigured`, `no_phone`, `provider_failed`, `reconciliation_required`, no approved sender), `completed`, `opted_out`, seller appointment reminders (hang off a booked callback; not their own state), manual queued rep texts with no schedule (rep to-do, surfaces as Nothing planned with label "Text waiting for you to send").

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

**Details** (notes + add note, attempts with recordings, appointments with Held/No-show/Reschedule/Cancel/Done/Snooze, offers, history): **not on the row.** They live on the lead page via Open lead. The current in-row detail panel is retired with the old UI.

---

## 5. Handled-reply rule (single definition for rows, counts, badge)

The latest inbound text (or missed call) on the property is **unhandled** unless, after it (ordered by `(created_at, id)`), one of these exists:
- a non-failed human text to the seller: no `campaign_id`, no `sequence_step_runs` row, and either no `metadata.generated_by` or `reply_source = 'approved_template'` (rep-approved template counts once sent; a later `delivery_failed` reopens as **Broken**, not New reply);
- a logged attempt (`acquisition_attempts.recorded_at`);
- a user-actor `dispo_set` or `my_leads_workflow` lead event;
- a next step created by a user (`fn_create_next_step`);
- a user-initiated enrollment (`enrolled_by_user_id` set; AI hot/nurture routes do not count).

Never counts: notes, opening the lead, AI replies, failed sends, system events.

**Concurrency:** human sends from the My Leads composer and the Inbox composer stamp `metadata.inbound_message_id` with the newest inbound shown when the composer opened (same convention the AI path already uses). A text handles reply X only if its stamp is X or later; a reply newer than the stamp stays unhandled. Coarse actions (attempt, dispo, next step, enrollment) use ordering only; the seconds-wide race is accepted, and the row always shows the newest reply time with 30 s refresh. **No new handling table.**

---

## 6. Page chrome

- **Tabs:** Needs attention (default) · Waiting on them · All leads, each with a live count. Right end of the tab bar: ⤢ expand/collapse all, 🔍 search (box hidden until clicked; searches name, address, phone within the current tab and chip).
- **Chips** under Needs attention (order: New lead, Call today, Due, New reply, Broken, Offer, Gone quiet, All reasons) and under Waiting (In a drip, Texted last, Offer out, Callback booked, All waiting). All reasons is selected on open; new leads are always on top so no "New lead default" is needed.
- **Stage dropdown** on every tab with counts; stacks with chips and search.
- **Pagination: page numbers, 25 per page**, page in the URL. The 30 s refresh re-fetches only the current page; if rows above the viewer changed, a small "List updated" note appears instead of moving rows. Load more is removed.
- **KPIs:** the six Today's activity tiles stay as they are (definitions unchanged, independent of filters). The four "Needs attention" tiles are removed; tab and chip counts replace them. Sticky bar mirrors the activity tiles only.
- **Sidebar badge:** count of New reply + Due + Broken in the viewer's own queue (replaces the Not contacted count, which is 0 in prod).
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
| Rep texts back (incl. approved template), send ok | Waiting · Texted last | Waiting on them · you texted 2m ago | drip-X |
| Rep's reply fails to send | NA · New reply (still) + Broken label | New reply · 9:12 AM | 💬 |
| Reply Y arrives while rep is sending for X | NA · New reply (Y) | New reply · Y time | 💬 |
| Note / open lead / AI auto-reply / call no answer (no text) | NA · New reply (still) | unchanged | 💬 |
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

Open for Jarrad only if he objects: the 3-business-day number.

---

## 10. Build plan (after Astra approval)

**Phase A — classifier, no UI (PR 1, worktree)**
- SQL `fn_my_leads_work_items(member, at, tab, chip, stage, search, page, page_size)` returning stage, place (your_move/their_move/neither), reason, reason_at, headline parts, drip status, next step, last touch, attempts, assigned_at, last inbound + handled flag, contact availability; plus `fn_my_leads_work_counts` over the same CTEs for tabs, chips and badge.
- Additive: `metadata.inbound_message_id` stamped on human sends from the My Leads composer and the Inbox composer; `reply_source = 'approved_template'` honored as human.
- Fixture tests for every row in section 8, repeated-inbound ordering, 400-lead timing (reuse the call-next integration harness).
- One-off read-only comparison script: for Jarrad's queue, every lead in today's Call next top ten, sections and drip section vs its new tab/chip; every lead not in Needs attention or Waiting must be explained.

**Phase B — UI behind `unified_queue` org flag (PR 2, stacked on PR 1)**
- Tabs, chips, stage dropdown, search, pagination, rows (collapsed/expanded), icons from Sandra's icon set, conversation box, six buttons + More, Undo for Call today, deep links, empty/error states, mobile layout.
- KPI tiles and badge per section 6; `comp_queue` re-pointed. Old components untouched; flag off renders today's page.
- Component tests (reason copy, button map per stage), synthetic Playwright per tab/chip/count/deep link/page refresh. Fable review, then Astra review at the same SHA.

**Phase C — enable for Jarrad**
- Flag on for the org; Jarrad works it; rollback = flag off (stamps are harmless). Then a separate retire PR removes strip, sections, adapter drip subtraction and the in-row detail panel.

Out of scope: Inbox predicates, `needs_human_attention` cleanup, Messages v2, calling queues, archive browsing, multi-rep features.
