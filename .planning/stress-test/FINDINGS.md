# My Leads adversarial browser findings

Candidate: `65c58eb063c0aa985e8bf838317d6a516b2cc726` (#527).
Production deployment verified READY: `sandra-fgdz2i83o-jarrad-5416s-projects.vercel.app`.
Research hypotheses are in PAGE-AND-MODALS.md, CONNECTED-FLOWS.md and DATA-AND-ENVIRONMENT.md; they are not verified defects.

## BUG-001 — Search loses focus and clears its displayed query

- Severity: P1 — normal typing cannot reliably enter a multi-character search.
- Status: REPRODUCED in production; fixed and retested on the isolated candidate.
- Identity: Jarrad signed in, Jarrad selected (empty queue). Maria was not used for this probe.
- Steps: click Search My Leads; type `a`; observe loading state; type `bc` after results return.
- Expected: input remains focused, displays `abc`, results follow current query.
- Actual: typing first character unmounts queue/search into Loading My Leads; document.activeElement becomes BODY. Search reappears blank; subsequent characters do not reach input.
- Evidence: browser AX transition removed queue nodes and showed Loading My Leads. Read-only DOM observation immediately afterward: activeTag=BODY; later search value="". No data writes submitted.
- Source lead: client.tsx filter effect clears snapshot/KPIs, unmounting queue; queue-local search draft resets on remount. Source attribution is supporting evidence, not the reproduction.
- Retest: fixed candidate returned the matching synthetic row and kept Search My Leads focused during refresh; unit coverage adds the focus contract.

## Test environment and boundaries

Dedicated local runtime reconstructed with same four synthetic principals and nine synthetic properties. Replay passed 216 baseline +13 My Leads migrations; extra history alias on current main is SELECT1 only. Original source ran at http://127.0.0.1:58700 and the fixed candidate at http://localhost:58701, both with local Supabase58321/58322 and no external provider credentials. Native password login uses real local authentication; live Hugo/provider integrations are not thereby verified. Test rep signed in through in-app browser.

The original production campaign performed no writes; fixed-candidate verification used only synthetic local leads and no calls, messages, or provider actions. The production owner view initially defaulted to Maria; only inspected, then switched to Jarrad before probes.

## BUG-002 — Manual outreach defaults to an unsupported Call combination

- Severity: P2 — ordinary attempt entry fails with no actionable explanation.
- Status: REPRODUCED in the isolated browser; fixed and retested.
- Identity/fixture: synthetic rep,101 My Leads Fixture Lane.
- Steps: Log attempt → Source Manual outreach → leave default Kind Call → No answer → valid past occurrence time → Save.
- Expected: default offered combination is valid, or field-level guidance explains unsupported choice.
- Actual: generic “The update could not be saved. Check the fields and retry.” No field identifies the unsupported pair.
- Control experiment: changing ONLY Kind to Other outreach saves and closes modal; queue moves to Contacted.
- Source corroboration: validation and DB accept manual+outreach, not manual+call.
- Retest: fixed candidate selected Other outreach when Manual outreach was chosen; the source-normalization unit test passes.
- Tool note: native datetime fill required a real keyboard increment to commit React state; that automation behavior is not classified as a product defect.

## BUG-003 — Saved offer missing from cached expanded history

- Severity: P2 — contradictory saved-state display can encourage retries.
- Status: REPRODUCED locally; fixed and retested for appointment detail.
- Steps: expand101 with no offers; log offer; observe row moves to Offer Sent with amount/overdue warning; inspect expanded $ OFFERS history; collapse/reopen row.
- Actual: summary shows pending$0.01 while history says No offers recorded. Collapse/reopen retains stale history.
- Control: full page reload followed by expansion fetches and displays the saved$0.01 offer. Read-only database receipt confirms exactly one offer, correct stage/status, zero unintended tasks/enrollments/eSign requests.
- Expected: successful mutation invalidates/refetches affected detail cache without requiring page reload.
- Retest: fixed candidate appointment booking immediately populated expanded detail without a full-page reload; the same revision invalidation covers the other workflow mutations.

## BUG-004 — Offer decline accepts a timestamp before the offer was sent

- Severity: P2 — invalid lifecycle chronology persists and triggers reassignment.
- Status: REPRODUCED in local browser and database; fixed at the database boundary and retested.
- Fixture104: offer sent2026-09-12T05:49:09.659Z. In Offer declined modal, submit2026-09-11T19:00:00Z.
- Actual: saved decline, Offer Declined shared status, Needs sequence, owner reassignment and queue exit.
- Expected: reject date before selected offer sent timestamp with field-specific explanation; no status/assignment write.
- Evidence: evidence/second-workflow-db.json; source corroboration found finite/nonfuture guard but no decline>=sent guard.
- Retest: fixed candidate SQL call with a one-minute-before-sent timestamp raised INVALID_INPUT and left the offer/property unchanged.

## BUG-005 — Fresh Not contacted lead cannot be handed off

- Severity: P1 — exposed primary workflow cannot complete for untouched new lead.
- Status: browser reproduced twice, including full reload; fixed at the database boundary and retested.
- Fixture107: untouched Not contacted synthetic lead. Handoff → Needs nurture → configured owner → Hand off lead.
- Actual: “This lead changed. Refresh before trying again.” Full reload/reopen produces same result. No competing UI writer modified this lead.
- Expected: valid handoff succeeds or identifies actionable eligibility reason; refreshing must not lead to an endless stale-state error.
- Retest: fixed candidate handed off fresh synthetic leads through the UI and SQL; materialized-row stale behavior remains covered by the two-user probe.

### BUG-005 diagnosis confirmed

Read-only DB/source review:107 had a valid implicit Not contacted/version0 state with no acquisition_queue_states row. The fix allows that state while preserving stale checks for nonzero versions, and records an archived sentinel before reassignment so the observer can suppress a false eligible clock. No failed submission mutated property/episode/command receipts.

### BUG-003 additional reproduction

Scheduling a future appointment on102 clears the no-future-next-step warning and displays the new appointment in the summary, but expanded APPOINTMENTS continues to say No appointments recorded. Same stale-cache family as saved offers.

## BUG-006 — Contacted guidance falsely marks an unanswered attempt as reached

- Severity: P2 — misleading qualification guidance.
- Status: REPRODUCED on synthetic102; fixed and retested.
- Actual: detailed guidance reads “Needs: reached ✓” while attempts list contains only No answer.
- Expected: Contacted means attempted outreach per PRD; successful seller contact must not be implied from queue stage alone.
- Retest: fixed candidate contacted detail showed follow-up-plan guidance and no reached checkmark; queue-row coverage passes.

## Fix verification on isolated candidate

The six defects above were fixed in `codex/my-leads-stress-fixes-20260912`, based on the original candidate. The fixed local app used the same four synthetic identities and no provider credentials.

- BUG-001: Search My Leads retained focus while filtering to one synthetic row; the queue stayed mounted during refresh.
- BUG-002: Manual outreach selected `Other outreach` automatically; the normalization unit test passed.
- BUG-003: Booking Sep 13, 2026 at 10:00 AM immediately rendered the appointment in expanded detail without a page reload.
- BUG-004: A decline timestamp one minute before `sent_at` raised `INVALID_INPUT`; the offer remained pending and the property remained `offer_sent`.
- BUG-005: A fresh implicit Not contacted lead handed off through the UI; SQL confirmed synthetic-owner assignment, `new_lead` status, and an archived `needs_sequence_handoff` sentinel row with an ineligible new episode.
- BUG-006: Contacted guidance showed `follow-up plan or offer decision`; `reached ✓` was absent.
