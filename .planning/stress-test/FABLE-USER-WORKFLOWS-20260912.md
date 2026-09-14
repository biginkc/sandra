# Fable user-workflow advice — 2026-09-12

Status: proposed workflow tests, NOT execution evidence.

Expanded plan: **26 journeys** — original Fable J1–J12 plus Codex J13–J26 below. The additions are grounded in `docs/my-leads/PRD.md` §§3–11 and are not attributed to Fable. All additions are **NOT RUN**.

Consulted authenticated Claude CLI with explicit `claude-fable-5-1`; response model usage confirms that model generated the advice. No tools were enabled for the advisor. Inputs: preserved PAGE-AND-MODALS.md and CONNECTED-FLOWS.md plus current rerun limitations. Those inventories describe an older source baseline, so old hypotheses are not current defects.

## Codex assessment and corrections

- The previous campaign DID include successful submissions and persistence. The latest rerun mostly repeated open/cancel and read paths. Fable's claim that no campaign submission has yet succeeded is incorrect; retain earlier evidence and label this proposed fresh run unexecuted.
- Manual outreach normalization was fixed in a9021cfe. J1 should verify the fix remains effective, not expect the old rejection.
- Current lifecycle dialog explicitly says decline applies Needs sequence and reassigns, with nothing enrolled or scheduled automatically. J4 must first verify that result. A revised-offer path requires confirmation of supported re-entry; do not invent direct offer access in the recipient queue.
- Handoff removes the lead from the active queue. J8's assumption it immediately appears in the recipient's active My Leads queue is unverified. Check assignment/history through the canonical lead and derive visibility from the actual approved rules.
- Do not assume a no-answer attempt advances to Contacted or that every attempt increments every KPI. Use the PRD/event definitions as the expected result before execution.
- J6 must use separate appointment fixtures for Held, No-show and Reschedule; do not assume a completed Held appointment can be rescheduled.
- J10: blocking a request before it reaches the server is not a lost-response test. A valid simulation must establish commit succeeded while the response was withheld, then verify retry produces no second write.
- A draft lost on deliberate cancel is not automatically a blocker. Compare draft behavior with approved requirements and distinguish inconvenience from wrong-record writes/data corruption.

## Recommended first workflow batch

1. Work a fresh synthetic lead: record unanswered outreach, record reached seller, add context, refresh and reopen; verify attempt history, actor, applicable stage and KPI semantics.
2. Qualify and offer: record motivation/readiness, log a precise offer amount and follow-up time, refresh and verify one pending offer and no invented task/provider send.
3. Decline and handoff: reject a pre-offer decline timestamp, then record a valid decline; verify Needs sequence, assignment/history and queue removal atomically.
4. Signed and archived: record a contract, verify Under Contract rather than Closed, cancel archive once, then confirm archive and verify preserved history.
5. Interrupted work: perform the same workflows with double submit, stale second tab, manager scope changes and save/refresh recovery. Verify persisted outcomes, not toasts.

Each execution receipt must identify candidate, fixture, browser steps, expected versus actual result after reload, backend corroboration, cleanup, and PASS/FAIL/BLOCKED/NOT RUN. Desktop only; no Maria or live providers. This advice is a test plan, not new browser acceptance.

## Original Fable advice (unmodified; apply corrections above)

Below are 12 desktop journeys built only from the inventory you supplied, plus the first five to run. The most recent rerun covered modal open/cancel, search, pagination and access only. Nothing in this campaign has yet demonstrated a successful submission or persisted outcome, so every P0 here is a first execution, not a repeat.

## Assumptions and ground rules

These are inferences, not supplied facts. Record which ones hold on the first run.

- **A1, attempt advances stage.** ATT-002 implies a valid logged attempt moves Not contacted to Contacted. Whether a No answer outcome does so is unstated.
- **A2, decline reassigns.** LIFE-006 and LIFE-007 imply Offer declined targets the pending offer, then reassigns the lead to the owner-configured recipient and removes it from the rep queue.
- **A3, no in-place revised offer.** OFFER-008 forbids a second pending offer. A revised offer therefore only exists after decline or another resolution, logged by whoever then holds the lead.
- **A4, page Refresh exists.** PAGE-026 and MOD-010 reference it.
- **A5, past-due appointments need seeded due times.** CF-004 says past choices get explicit handling, so Held and No-show fixtures likely cannot be created from the booking picker.
- **A6, reassign-back uses the lead page assignee widget** from OL-002.
- **A7, datetimes are Central.** MOD-012 and CF-004.
- **Persistence oracle for every journey:** page Refresh, then collapse and re-expand the row, then Open lead, then an authorized isolated backend read. A toast counts for nothing. Use fixtures with no unread SMS, since opening the full lead acknowledges unread SMS.
- **Provider boundaries:** Start call, wrap-up callbacks and Dropbox Sign sending are BLOCKED. Booking runs the appointment action that has calendar, notification and enrollment effects, so it is SIMULATED only with inert doubles, otherwise BLOCKED.

## Journeys

**J1, P0. Missed calls then reached seller.**
- **Persona and objective:** an Acquisitions rep who is an assigned member works a fresh lead from Not contacted to Contacted.
- **Setup:** synthetic lead L1 assigned to the rep, stage Not contacted, phone present, calling disabled, no unread SMS. Note the current rep-period KPI values.
- **Steps:** expand Not contacted, expand L1, click Log attempt, set Source DialPad, Kind Call, Outcome No answer, occurrence a few minutes ago, Save. Repeat with Outcome No answer. Third time set Outcome Reached with a short note, Save.
- **Persisted outcomes:** after Refresh, L1 sits in Contacted, its attempts group lists three entries newest-first with the rep as actor and the entered times, and KPI numerator and denominator move once per attempt. Open lead shows the same three attempts. Record whether the first No answer alone moved the stage, which settles A1.
- **Branch:** on the second attempt, double-click Save. Then open a fourth attempt with Source Manual and leave the default Kind, then Save. H-ATT-01 predicts rejection. If rejected, switch Kind to Other outreach and confirm the draft survived and the retry saves once.
- **Fail if:** attempts count differs from clicks, the stage regresses or never advances, actor or time is wrong, or the Manual rejection loses the draft or gives no field-level error.

**J2, P0. Seller readiness.**
- **Persona and objective:** the same rep marks L1 ready for an offer.
- **Setup:** L1 in Contacted from J1, plus synthetic L2 in Contacted with an existing temperature.
- **Steps:** expand L1, click Ready to make an offer, type a specified motivation, pick Warm, Save. On L2 open the same dialog, choose No motivation provided, leave temperature Unchanged, Save.
- **Persisted outcomes:** both rows move to Needs offer after Refresh. Open lead shows shared status Interested for each, L1 keeps the motivation text and Warm, L2 shows explicit no-motivation and its original temperature. One offer-needed clock per lead starts, not two. No appointment or task appears.
- **Branch:** on L1 type motivation, then switch to No motivation provided, then back to specified. The text must be cleared and required again. Cancel dirty, reopen on L2, confirm no leaked text.
- **Fail if:** temperature is invented for L2, blank motivation is accepted, shared status is not Interested, or a task or appointment was created.

**J3, P0. Direct offer.**
- **Persona and objective:** the rep logs a verbal offer on L1.
- **Setup:** L1 in Needs offer. A second browser tab open on the same page for the branch.
- **Steps:** expand L1, click Log offer, enter amount 125000.50, method Verbal, sent time now, follow-up two days later, Save.
- **Persisted outcomes:** after Refresh L1 sits in Offer Sent with Contract signed as primary. The offers group and Open lead show exact cents, Verbal, the rep as actor and the sent time. Changing the KPI period does not alter the record. No contract send, task or calendar entry exists.
- **Branch:** on a fresh synthetic L3 in Needs offer, open Log offer in tab A. In tab B log a valid offer on L3. Submit tab A. Expect an atomic rejection with the draft retained. Refresh tab A, reopen, confirm only one pending offer.
- **Fail if:** two pending offers exist, cents are rounded, method or actor is wrong, or the stale submit succeeds.

**J4, P0. Offer declined, then revised offer.**
- **Persona and objective:** the rep records the seller declining, then the lead holder logs a revised offer.
- **Setup:** L1 in Offer Sent. Owner has configured a handoff recipient who is an active Acquisitions member. Also prepare L4 in Offer Sent for the unset-recipient branch, tested before configuring the recipient if your environment allows it.
- **Steps:** expand L1, click Offer declined, set a time after the sent time, Save. Sign in as the recipient or use the owner selector, find L1, and log a new offer with a different amount.
- **Persisted outcomes:** after Refresh L1 is gone from the rep queue. Open lead shows the first offer outcome as declined, the reassignment and history in one consistent state, and no enrollment or task. Record the stage and shared status L1 lands in for the recipient, because the supplied facts do not name it. The second offer persists as the only pending offer with the new actor.
- **Branch:** with the recipient unset, attempt Offer declined on L4. Expect a clear owner-settings error and no partial decline. Second branch, open Offer declined on L1 in tab A, sign the contract in tab B, submit tab A. Expect rejection and no declined contract.
- **Fail if:** a decline writes without reassignment or vice versa, a declined-and-signed lead exists, the recipient error is vague, or the revised offer creates a second pending offer.

**J5, P0. Signed contract, then archive.**
- **Persona and objective:** the rep closes the loop on a new synthetic L5 and files it.
- **Setup:** L5 in Offer Sent with one pending offer whose ID you have recorded.
- **Steps:** expand L5, click Contract signed, enter a valid past time and the matching offer ID, Save. Refresh. Change KPI period to Month. Refresh. Expand Under Contract, expand L5, click Archive, tick the confirmation, Save. Refresh.
- **Persisted outcomes:** after the first save L5 shows in Under Contract with Archive as the only action, and Open lead shows Under Contract, never Closed. After archive L5 leaves the active queue, Open lead still shows Under Contract with the full history preserved and no Closed or Dead status.
- **Branch:** before confirming archive, tick then untick the box, Cancel, reopen. A fresh tick must be required. Also run Contract signed directly on a Not contacted synthetic with no offer ID and confirm Under Contract without a fabricated call or offer.
- **Fail if:** the stage or shared status becomes Closed, archive succeeds without a fresh confirmation, history is lost, or the no-offer path is blocked by an invented prerequisite.

**J6, P1, SIMULATED or BLOCKED. Appointment held and no-show.**
- **Persona and objective:** the rep schedules a next step from Contacted, then records the outcome later.
- **Setup:** inert calendar, notification and enrollment doubles verified before any booking. Two Contacted synthetics, L6 and L7, with seeded past-due appointments if A5 holds. Otherwise mark this BLOCKED.
- **Steps:** on a third Contacted synthetic click Schedule next step, choose tomorrow, a quarter-hour time, 30 minutes, self as assignee, a note, Book. On L6 record Held. On L7 record No-show.
- **Persisted outcomes:** one task with the right property, assignee, due and end in UTC, visible in the row detail and agreeing with Tasks and Calendar after Refresh. Held and No-show each apply once and appear in history. Stages do not change unless the app does so, and if they do, record it rather than assuming.
- **Branch:** double-click Book. Then repeat No-show on L7 from a stale second tab and expect no second outcome. Reschedule L6 onto a new slot and confirm the same task moved rather than duplicated.
- **Fail if:** two tasks or two outcomes exist, the note or assignee is wrong, or the stale repeat writes.

**J7, P1. Callback follow-up after a missed call.**
- **Persona and objective:** the rep sets a callback after J1 and works it from the queue.
- **Setup:** L1 or another Contacted synthetic with no unread SMS. Wrap-up callbacks are BLOCKED because they need the softphone, so the callback is created from the lead page.
- **Steps:** Open lead, create a Callback task owned by self with a due time an hour ahead, browser Back, expand the row, use Snooze 1 day, Refresh, then Done.
- **Persisted outcomes:** the due time shifts by exactly one day, then the task shows completed, both surviving Refresh and matching the lead page. Stage is unchanged.
- **Branch:** click a Snooze preset rapidly three times. Expect one snooze applied, not three.
- **Fail if:** the due time moves more than once, Done does not persist, or the task attaches to a different property after Back.

**J8, P0. Handoff and reassign back.**
- **Persona and objective:** the rep hands a nurture lead to the configured recipient, who later sends it back.
- **Setup:** use two separate fixtures: L8 with a materialized Contacted queue row, and L8b as a fresh implicit Not contacted/version-0 lead with no `acquisition_queue_states` row. Both are assigned to the rep. Recipient configured. Note each assignment start time.
- **Steps:** expand L8, click Handoff, reason Needs nurture, confirm the recipient shown, Save. Refresh. As the owner, select the recipient in the owner selector and confirm L8 appears. Open lead as the recipient and reassign to the original rep. Return to the rep view and Refresh.
- **Persisted outcomes:** both queue representations leave the rep's active queue through an atomic Needs sequence handoff, with the reason in history and an archived sentinel for the implicit row. Verify recipient visibility using supported queue/lead rules rather than assuming it appears in My Leads. After supported reassign-back, the materialized lead returns with a new assignment episode whose timer starts now rather than reusing the old one.
- **Branch:** open Handoff on another lead, then as the owner change the recipient in settings, then submit. Expect a clear stale-settings rejection or an explicit current-recipient result, and record which. Also submit with a blank reason and expect a field error.
- **Fail if:** a handoff writes to a stale recipient silently, history is missing, or the returned lead borrows the old timer.

**J9, P0. Manager scope and attribution.**
- **Persona and objective:** the owner reviews a rep's queue and logs an attempt on the rep's behalf.
- **Setup:** owner account, rep with J1 leads, a second member with no Acquisitions designation, a disabled member with history.
- **Steps:** as owner select the rep, confirm label, sections and KPIs match the rep's own view. Log a DialPad Reached attempt on one of the rep's Contacted leads. Refresh. Switch to the disabled member and confirm rows and KPIs reflect their history. Sign in as the non-designated member and load the page.
- **Persisted outcomes:** the attempt's actor is the owner, not the rep, in the row detail and on Open lead. The rep's own view shows the attempt. The non-designated member sees an explicit access or disabled state and no selector.
- **Branch:** alternate the owner selector rapidly between two members while requests are outstanding, then stop. The label, rows and KPIs must all belong to the final selection.
- **Fail if:** the attempt is attributed to the rep, a stale response overwrites the current scope, or the member sees a selector.

**J10, P0. Stale tab and duplicate submission.**
- **Persona and objective:** the rep has two tabs open and a teammate acts in between.
- **Setup:** L9 in Contacted, page open in tabs A and B.
- **Steps:** in tab A open Log attempt and fill DialPad, Reached. In tab B hand off L9. Submit tab A. Expect rejection. Click Refresh in tab A with the dialog still open, submit again, record the result. Close the dialog, reopen if the row still exists, and retry.
- **Persisted outcomes:** exactly zero attempts attached to the old assignment episode. The handoff stands. Record whether Refresh alone made the modal recover, which resolves H-MOD-01.
- **Branch:** simulate a lost response by blocking the submit request in devtools after it is sent, then retry the same payload. Label this SIMULATED. Expect one durable attempt and a reused idempotency key.
- **Fail if:** an attempt lands on the wrong episode, the retry duplicates, or the only recovery is a full page reload with the draft lost.

**J11, P1. Note drafts across collapse and refresh.**
- **Persona and objective:** the rep writes context notes while switching between leads.
- **Setup:** two Contacted synthetics L10 and L11 expanded.
- **Steps:** type a multiline note on L10 without saving, collapse the Contacted section, reopen, observe the composer. Then type on L10, expand L11, type there, save L11 with Ctrl or Cmd plus Enter, then save L10 with the button.
- **Persisted outcomes:** each note lands on its own property with the rep as author, trimmed, newest-first, surviving Refresh. Record whether the collapsed draft survived or was silently lost, which resolves H-PAGE-02.
- **Branch:** click Save and press the shortcut at nearly the same moment on one note. Expect one note.
- **Fail if:** a draft appears on the wrong lead, two identical notes exist, or a draft is lost with no warning.

**J12, P1. Manager configures the team.**
- **Persona and objective:** the owner enables a new rep and sets the handoff recipient.
- **Setup:** owner account, a member without Acquisitions designation, an active designated member as recipient candidate.
- **Steps:** open Manage Acquisitions, toggle the member on, Refresh, confirm they now load the page. Set the recipient to the candidate, Save, Refresh, confirm it stuck. Attempt to save the recipient with nothing selected.
- **Persisted outcomes:** designation and recipient survive Refresh and a new sign-in. Disabling a member later keeps their historical events visible via the owner selector.
- **Branch:** toggle designation on and off rapidly five times. Expect a busy guard and a final state that matches the last completed request.
- **Fail if:** the empty recipient save is enabled, a rapid toggle leaves an inconsistent state, or history disappears on disable.

## Execute first

1. **J1** missed calls to reached seller. It is the first real submission of the campaign and resolves A1 and H-ATT-01.
2. **J3** direct offer with the two-tab branch. It is the highest-value persistence oracle and checks exact cents.
3. **J5** signed contract then archive. It proves the end of the ladder and the Under Contract not Closed rule.
4. **J10** stale tab. It settles H-MOD-01 before the remaining two-tab branches in J3, J4 and J8 are interpreted.
5. **J9** manager scope. It confirms attribution and scoping before anyone reads rep KPIs as evidence.

Run J4 and J8 right after these, since both depend on a configured recipient and on A2 being settled. Keep J6 SIMULATED or BLOCKED until inert doubles are verified.

## Additional user journeys — Codex, 2026-09-12

These cover business situations absent from J1–J12, even where they reuse a control. Every case uses dedicated synthetic records, desktop browsers, and the same persistence/evidence contract above. P0 means business-critical correctness; P1 means important operational coverage. No test below authorizes mobile work, Maria's records, external customer contact, or paid providers. Fixture/time/failure injection must stay isolated and must be labeled simulated. Missing simulation capability means BLOCKED, never PASS.

### J13 — P0 — Monday morning: decide which leads need attention first

- **Persona/objective:** a rep returns after the weekend and prioritizes overdue work.
- **Setup:** synthetic Friday 16:50 Central assignment with no call; after-hours assignment; non-call-contacted lead still awaiting its first call; Contacted lead without a next step; Needs offer lead near 12 elapsed hours; Offer Sent lead near follow-up due; Under Contract lead. Use an isolated controllable clock or precomputed boundary fixtures, not a changed system clock.
- **Steps:** inspect before and after Monday 09:20 Central, expand warning rows, switch Today/Week/Month, leave and reopen the page; repeat with a DST-crossing weekend fixture.
- **Expected:** Friday's first-call warning starts at Monday 09:20; off-hours pause rather than reset its accumulation. Needs offer uses elapsed hours. Within each stage warning leads precede others, then newest assignment. Stale counts distinct current warning leads and is period-independent. Merely opening the page changes no activity/timestamp.
- **Break branch:** one Contacted lead has both missing-next-step and outstanding-first-call warnings; it counts once in Stale. Leave a tab hidden across the boundary and bring it back.
- **Fail if:** warnings use wall-clock weekend minutes, reset on login, use working hours for offer age, duplicate Stale counts, or remain stale after supported refresh. Compare exact ordering and timestamps with fixture facts.

### J14 — P0 — Reach out without a call, then follow up by phone

- **Persona/objective:** a rep records non-call outreach first, then a later external phone attempt.
- **Setup:** new eligible assignment with no call evidence, within an active first-call warning window.
- **Steps:** log Manual outreach with an actual occurrence time and outcome; reload. Then log a distinct DialPad call with its actual time and optional recording omitted; reload and inspect both entries.
- **Expected:** first outreach advances Contacted but does not fabricate call initiation or satisfy the first-call clock. The qualifying recorded call provides the appropriate first-call evidence under the existing external-call contract. Both genuine attempts remain distinct and have original actor/time attribution.
- **Break branch:** record No answer, rather than Reached, for the call. Contacted still means an attempt; Contact rate reflects reached outcomes only. Confirm no recording URL is required.
- **Fail if:** non-call outreach stops the call clock, unanswered calling is treated as successful contact, saving replaces occurrence time with now, or advanced status regresses. This tests the two-event clock distinction, beyond J1's attempt sequence.

### J15 — P0 — Catch up on yesterday's external activity

- **Persona/objective:** a rep enters yesterday's DialPad work during today's admin time.
- **Setup:** known period totals; synthetic eligible assignment before the activity; yesterday/today Central boundary with explicit UTC equivalents.
- **Steps:** save two historical attempts, one Reached and one No answer; select yesterday, today, and a custom range spanning both. Reopen the lead and inspect event chronology.
- **Expected:** occurrence time governs attempt totals and contact rate; save time does not move activity into today. The fixture's two new attempts contribute one reached numerator and two denominator entries. Page visits and period changes create nothing.
- **Break branch:** use 23:59 and 00:01 Central and a browser timezone different from Central. Correct an invalid date field before submitting, without recreating the form.
- **Fail if:** late entry counts in the wrong day, Central conversion drifts, errors erase valid fields, or historical events reorder by save time where occurrence ordering is required. No unsupported edit-existing-attempt UI is assumed.

### J16 — P0 — Finish a productive conversation without unnecessary appointments

- **Persona/objective:** a rep records an offer and signed contract after one productive seller conversation.
- **Setup:** Contacted lead with no appointment and unanswered motivation, plus a separate fresh Not contacted lead for the contract-only path.
- **Steps:** from Contacted choose Log offer directly; provide explicit motivation, amount, method, sent time and follow-up; save. Record Contract signed. On the second lead record Contract signed directly with no offer ID.
- **Expected:** no mandatory readiness-screen or appointment detour; required motivation is enforced on the direct offer. Final state is Under Contract, not Closed. The contract-only path invents no intermediate offer, call, appointment or readiness event.
- **Break branch:** select Dropbox Sign as the logged offer method; prove this only records the method and invokes no signature send. Omit motivation first, then choose No motivation provided and recover.
- **Fail if:** artificial stage prerequisites block legitimate work, motivation is bypassed, temperature is invented, or recording an offer creates provider sends/tasks. Distinct from J2/J3's staged qualification path.

### J17 — P0 — Keep working an advanced lead without moving it backward

- **Persona/objective:** a rep calls or adds context after an offer is already pending.
- **Setup:** Needs offer and Offer Sent fixtures with established milestone timestamps; an Under Contract fixture for supported notes/history actions only.
- **Steps:** on the first two leads log another attempt and add a note, then reload My Leads and Open lead. Inspect the Under Contract record's history through its available controls.
- **Expected:** new outreach persists without regressing either stage or shared milestone to Contacted. Existing offer and stage-entry timestamps remain intact; notes attach to the original property.
- **Break branch:** a permitted actor changes shared status through the canonical Leads surface while My Leads is open. Refresh and inspect; do not expect arbitrary reverse synchronization into queue stage.
- **Fail if:** a later call resets offer progression/timing, creates another offer, resurrects a terminal record, or a stale action overwrites the newer milestone. Record observed shared-status/queue differences against PRD §4 rather than treating every difference as a bug.

### J18 — P1 — Recover after a cancelled or missed next step

- **Persona/objective:** a seller cancels a meeting and the rep must arrange another next step.
- **Setup:** Contacted synthetic with a future appointment; separate future callback and past-due appointment fixtures. Calendar/notification/enrollment effects must be inert before scheduling actions.
- **Steps:** cancel the appointment through its confirmation flow; reload and inspect Contacted's indicator. Deliberately create a replacement future next step; verify its due/assignee across queue and Calendar/Tasks. On separate fixtures complete the callback or record No-show, then inspect the warning.
- **Expected:** cancelled, completed and elapsed items no longer satisfy the future-next-step rule. A valid future replacement clears that condition. Completing a meeting neither qualifies the seller nor automatically schedules another task.
- **Break branch:** cancel the cancellation confirmation first; no state changes. Put a second valid future callback on the lead: cancelling the appointment alone must not falsely imply no future next step.
- **Fail if:** warning stays cleared by an invalidated appointment, a remaining future item is ignored, or replacement duplicates the task. This covers next-step continuity, beyond J6's outcome storage. BLOCKED if side effects cannot be isolated.

### J19 — P1 — Work an overdue offer follow-up

- **Persona/objective:** a rep returns to an outstanding offer after its follow-up deadline.
- **Setup:** Offer Sent fixture with a known required follow-up time and no outcome; a second non-overdue offer.
- **Steps:** inspect before/after the deadline with controlled fixtures, reopen the pending offer, record a genuine follow-up attempt and note, reload, then resolve the offer through a supported signed or declined action.
- **Expected:** the due offer receives its warning independently of KPI period. A call/note alone does not invent an offer outcome or silently extend its follow-up. Supported resolution updates the lifecycle and applicable warning consistently.
- **Break branch:** select a KPI range excluding the offer's sent date; the active pending lead remains visible and overdue. Keep a detail row open during resolution from another tab.
- **Fail if:** period selection hides outstanding work, a note silently reschedules the offer, or the stale detail continues to offer an actionable pending outcome after refresh. No follow-up-date editor is assumed.

### J20 — P0 — Transfer a book of work without transferring historical credit

- **Persona/objective:** a manager moves an active lead from rep A to rep B while reviewing performance.
- **Setup:** lead with A-attributed attempts, offer and held appointment; known A/B totals; owner and both reps. Use separate eligible assignment fixture for first-call timing.
- **Steps:** save baseline A/B period metrics, reassign through supported canonical controls, refresh both queues, then have B perform one permitted new action. Recheck owner-selected and rep views.
- **Expected:** ownership moves; prior events retain A's credit and the new event belongs to its actual actor. Owner viewing changes no attribution. A new eligible assignment's call clock cannot be satisfied by A's old call.
- **Break branch:** select a historical period after transfer; preserve historic accountable appointment/offer credit. Verify the owner's sidebar badge stays scoped to the signed-in owner while content shows B.
- **Fail if:** historical totals migrate with current assignment, owner visits count as activity, or an old call falsely satisfies a new assignment. Distinct from J8's handoff and J9's owner action attribution.

### J21 — P1 — Start with an empty queue and receive the first lead

- **Persona/objective:** a newly designated rep starts their first shift.
- **Setup:** synthetic enabled rep with no history or assigned work; synthetic existing/launch-initialized Contacted lead with unknown original timing; separate new assignment.
- **Steps:** sign in, inspect empty sections and KPI states; assign the new lead through supported owner controls and refresh. Separately inspect the launch-initialized fixture.
- **Expected:** empty data is usable and honest: zero counts versus unavailable zero-denominator rates, no fabricated instant first calls. The new assignment appears with eligible timing; the initialized record retains its explicit historical/unknown timing and does not gain fake attempts.
- **Break branch:** search for a missing lead, then clear search after assignment; distinguish a filtered empty result from no assigned work. Do not run cohort initialization against real records.
- **Fail if:** rates imply success with no observations, initialization fabricates history, new work fails to appear, or an empty-state screen prevents recovery.

### J22 — P1 — Find the right seller among similar records and return to the queue

- **Persona/objective:** a rep receives an inbound reference and locates the correct property before recording a note.
- **Setup:** more than one queue page, two similar seller names at different addresses, and a known formatted phone match; fixtures have no unread SMS to avoid incidental acknowledgement effects.
- **Steps:** search by name, narrow by address, try formatted/unformatted phone, expand the correct row, inspect its history, Open lead, then browser Back and record a unique note on the intended lead.
- **Expected:** visible identity stays coherent across queue/detail/canonical route; the note persists only on the selected property. Returning to the queue remains usable. Record whether filters/expansion are preserved without inventing a persistence requirement.
- **Break branch:** clear search while an old detail request is pending, load more, then select the similar record. Check no history or action payload from the prior property leaks into it.
- **Fail if:** the wrong property opens or receives a note, history mixes, or pagination duplicates/skips records in an unchanged fixture set. This turns search/pagination probes into a wrong-record prevention journey.

### J23 — P0 — Recover from session expiry or revoked access mid-task

- **Persona/objective:** a rep finishes a form after their session expires or their assignment is removed.
- **Setup:** dedicated synthetic authenticated session and disposable lead, plus independent authorized owner session. Expiry injection affects only the test session; never inspect/export browser secrets.
- **Steps:** open and fill a workflow form; expire that session through supported test setup or revoke its specific permission; submit. Reauthenticate or restore authorized access, reopen the correct lead and complete the intended operation only if still authorized.
- **Expected:** unauthorized submission has no partial write; UI provides an honest recovery path. New sign-in cannot silently submit the old user's action or leak their data. Exactly one authorized final operation exists.
- **Break branch:** repeat with the lead reassigned and with a still-valid login whose mutation permission was revoked. Draft preservation is assessed separately from authorization correctness.
- **Fail if:** client-visible controls bypass server authorization, success appears without a write, old identity/record is reused after sign-in, or partial milestones remain. Mark session-expiry branch BLOCKED if supported isolated setup is unavailable.

### J24 — P0 — Distinguish failed save from saved-but-refresh-failed

- **Persona/objective:** a rep experiences a connection problem while saving an offer and avoids entering it twice.
- **Setup:** disposable lead and scoped network fault harness with commit observability; record baseline offer/event counts.
- **Steps:** first fail a request before it reaches the server and verify no write. Restore and retry. On a separate fixture allow a confirmed commit but fail the subsequent queue/detail refresh; recover using refresh/reopen before entering anything again.
- **Expected:** pre-commit failure remains retryable; post-commit failure leaves one discoverable durable offer with the right actor/amount/time. UI must not imply an unsaved state that only permits duplicate creation. These two failure modes have separate receipts.
- **Break branch:** lose the response only after confirmed commit and retry the identical payload; compare idempotency/event counts. Also verify other loaded rows remain usable during a single detail-read failure.
- **Fail if:** a toast masks missing persistence, recovery duplicates a committed offer, partial data persists, or recovery becomes permanently stuck. This expands J10's single lost-response branch into an explicit recovery decision journey. BLOCKED without controlled fault isolation.

### J25 — P0 — Respect a newly applied DNC or wrong-number restriction

- **Persona/objective:** a rep discovers the contact should not receive further outreach while working a queued lead.
- **Setup:** separate synthetic DNC and wrong-number fixtures, calling disabled, no real numbers/providers; authorized existing suppression actions only.
- **Steps:** keep a row/form open, apply the supported DNC restriction from the canonical surface or isolated fixture setup, then attempt the formerly available action and refresh. Separately log a Wrong number outcome and inspect its documented downstream eligibility/history.
- **Expected:** existing server DNC/opt-out rules remain authoritative, history remains readable as permitted, and no provider attempt occurs. Wrong number, DNC and Needs sequence retain distinct meanings; handoff is not a suppression substitute.
- **Break branch:** use a second contact/phone slot on the wrong-number fixture to verify existing phone-wide/slot semantics from the canonical suppression contract before asserting an outcome.
- **Fail if:** a stale form bypasses DNC, suppression is erased by reassignment/readiness, or the page conflates nurture with DNC. Do not infer that every note/history action is forbidden; validate the existing action-specific contract.

### J26 — P1 — Research the seller's history before deciding the next action

- **Persona/objective:** a rep takes over a complicated lead and reads earlier attempts, notes, appointments and offers before adding context.
- **Setup:** synthetic property with multiple pages in each available history group, distinct authors/timestamps, optional recording links pointing only to owned inert fixtures, and no recording on some attempts.
- **Steps:** expand the lead, load older notes/attempts/offers independently, open an available safe recording reference, return, append a factual note, then refresh and reopen the canonical lead.
- **Expected:** each history group keeps its own cursor/order and correct property/author. Missing optional recordings are honest. The new note appears once in the shared append-only history without rewriting earlier context.
- **Break branch:** add a note from another authorized test session while an older history page is loading; retry one failed group without reloading unrelated groups.
- **Fail if:** pagination mixes groups/properties, inserts duplicate IDs, loses the latest persisted note after refresh, or an unavailable optional recording prevents working the lead.

## Execution batches for the expanded plan

1. **Core business correctness:** original first batch plus J14, J16, J17 and J20.
2. **Daily workload continuity:** J13, J15, J18, J19 and J21; scheduling/time simulations require proven isolated setup.
3. **Identity and recovery:** J22–J26, plus original stale-tab and configuration cases.

For each journey record the exact candidate, fixture IDs, browser/account, setup preconditions, steps actually performed, screenshots where useful, before/after persisted evidence, cleanup, and separate branch outcomes. A parent journey is not fully PASS while a required branch is BLOCKED or NOT RUN. This update adds planning coverage only; it does not expand prior browser-pass claims.
