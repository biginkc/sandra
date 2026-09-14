# My Leads fix verification

The six defects from the desktop stress campaign were fixed in the isolated worktree `codex/my-leads-stress-fixes-20260912`, based on `origin/main` `65c58eb063c0aa985e8bf838317d6a516b2cc726`.

## Product fixes

- Search refresh no longer unmounts the queue and search input while the debounced request runs.
- Rep and reporting-period changes clear the prior queue and KPI scope while the replacement read is pending.
- Manual outreach source selection normalizes Kind to the supported `outreach` value.
- Successful workflow and appointment mutations invalidate expanded detail caches once per revision without refetching on unrelated row toggles.
- Revision invalidation clears collapsed in-flight and cached detail markers too, so reopening a row after another mutation always schedules a fresh read.
- Offer decline rejects an occurrence timestamp earlier than `sent_at` in the database function.
- Fresh implicit Not contacted leads (no active queue row, expected version 0) can be handed off transactionally with an archived suppression sentinel.
- Contacted guidance no longer implies that an unanswered attempt reached the seller.

## Browser evidence

Using the synthetic owner account in the fixed local app (`http://localhost:58701/my-leads`):

- Searching for `Stress not_contacted 07` returned exactly one row and retained focus on Search My Leads.
- Booking Sep 13, 2026 at 10:00 AM on `Stress contacted 01 Fixture Lane` immediately rendered the appointment in the expanded Appointments group without a full-page reload.
- Manual outreach selected `Other outreach` automatically.
- Contacted detail showed `follow-up plan or offer decision`; `reached ✓` was absent.
- Handing off fresh synthetic leads1006 and1008 with `Needs nurture` removed them from the rep queue.

## Database evidence

- The chronology guard raised `INVALID_INPUT` for a one-minute-before-sent decline; the offer stayed pending and the property stayed `offer_sent`.
- The fresh handoff ended with `assigned_user_id` set to the synthetic owner, `status = new_lead`, an archived `needs_sequence_handoff` queue sentinel, and an ineligible recipient episode, preventing a new live assignment clock.
- The 23:45 Central / 90-minute appointment stored the expected 04:45–06:15 UTC task window for synthetic property 102.
- No real account, provider, outbound message, eSign request, or paid integration was used.

## Automated checks

- `npm test`: 3,789 passed.
- `npm run test:rtl`: 1,279 passed.
- `npm run typecheck`: passed.
- `npm run verify:migration-safety-unit`: 60 passed.
- `npm run build`: passed; existing dynamic-route diagnostics were emitted for unrelated cookie-using routes.
- Changed-file ESLint: only the pre-existing `set-state-in-effect` finding in `client.tsx` remains.
- Repository-wide ESLint still reports the repository's existing 369 errors / 125 warnings outside this change; it is not a candidate regression.
