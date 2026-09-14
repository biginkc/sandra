# Connected My Leads stress-test matrix

Source baseline: `65c58eb0`. All cases are **PLANNED / UNVERIFIED**. This document inventories code and proposes adversarial tests; it does not record successful browser execution. No provider effects are permitted during this campaign. Calls, SMS sends, signatures, sequence execution, calendar sync/notifications and paid enrichment require isolated test doubles or inert fixtures. Even opening a full lead acknowledges unread SMS, so use dedicated synthetic records.

## Common execution contract

For every popup/control: pointer and keyboard opening; Tab/Shift-Tab focus order; Escape; outside click; explicit cancellation; reopen; empty and invalid values; valid synthetic submission; pending controls; rapid duplicate input; failure and retry; refresh/reopen persistence; wrong-record prevention after navigation; mobile 390px and 200% zoom. Record screenshot, observed result and exact record identity. A toast is not a persistence oracle. Cross-check the actual UI after refresh and corroborate saved state through authorized isolated backend reads. Keep untested cases unverified.

## Direct My Leads connected controls

| Case ID | Surface/actions and adversarial variations | Expected oracle | Status |
|---|---|---|---|
| CF-001 | Schedule next step: open A, Close, Escape, outside click, Tab/Shift-Tab, picker open then switch B, filter/rep change, narrow viewport | Correct lead binding; no booking on dismiss; no hidden interactive picker; usable focus/geometry | Planned/unverified |
| CF-002 | Appointment date previous/next month; all 96 quarter-hour choices; durations 15/30/45/60/90; self/other assignee; optional note empty/whitespace/multiline/very long | Exactly one correct property/assignee task with due/end UTC and note; queue/detail/Tasks/Calendar agree | Planned/unverified |
| CF-003 | Omit date, time, assignee individually; timezone loading/error; empty roster | Submit unavailable or truthful validation; no partial write | Planned/unverified |
| CF-004 | Today elapsed time; midnight; 23:45 plus 90 minutes; browser versus assignee timezone; DST nonexistent/repeated time; leap day | Correct UTC/end label; nonexistent wall time blocked; explicit handling of past choices | Planned/unverified |
| CF-005 | Adjacent appointment vs overlapping appointment; reschedule onto own slot; overlap then edit to nonoverlap | Soft warning only; no self-overlap; warning matches current inputs | Planned/unverified |
| CF-006 | Slow timezone lookup, rapid assignee change then submit; slow old overlap response after latest edits | Old timezone/warning cannot govern latest submission | Planned/unverified |
| CF-007 | Double-click booking; lost response then retry; close/reopen after failure; keyboard submit pending | Same-open retry one task/idempotency key; later genuine open new key; no duplicate side effects | Planned/unverified |
| CF-008 | Past-due Held and No-show on separate fixtures; exact due boundary; stale second tab repeats | Correct completion outcome once; queue/KPI/history agree | Planned/unverified |
| CF-009 | Past-due Cancel then Never mind; Cancel then Yes cancel; server failure; pending repeat | Only confirmed successful cancellation writes; failure preserves state | Planned/unverified |
| CF-010 | Reschedule past/upcoming appointments; choose every duration; dismiss then reopen | Same task and assignee retained; due/end move; no duplicate task/history effect | Planned/unverified |
| CF-011 | Upcoming overflow keyboard opening; Reschedule then Escape; cancel native confirm reject/accept | Focus returns to visible trigger, never invisible trigger; cancelled action does not write | Planned/unverified |
| CF-012 | Callback Done; Snooze 1 day/3 days/1 week; dismiss; rapid repeated preset; DST crossing | Generic task mutation, not appointment RPC; due/status persists correctly | Planned/unverified |
| CF-013 | Add note open/close; button and Cmd/Ctrl+Enter; Enter newline; empty/whitespace; 1/4999/5000 chars; emoji; HTML-looking text; unbroken word | One trimmed correct-author/property note; no interpreted HTML; usable layout | Planned/unverified |
| CF-014 | Note failure/retry; button plus shortcut; collapse while pending; edit A then change B; refresh pending | Draft restored on failure, cleared on success; no wrong-record draft/write; no accidental duplicate | Planned/unverified |
| CF-015 | Another tab adds note; more than 200 notes; paginated history then new insert | Correct ordering; no duplicate IDs or missing latest notes | Planned/unverified |
| CF-016 | Open lead correct record; browser Back; Zillow new tab; recording present/absent/malformed | Correct route/record and safe recording target; usable return to queue | Planned/unverified |
| CF-017 | Call disabled/no phone/no contact/DNC; stale DNC change; active call; repeated Call | Server eligibility authoritative; inert transport receives at most one intended call | Planned/unverified |
| CF-018 | Dialer search name/number; pasted punctuation; keypad/backspace; invalid/10-digit manual number; suggestions and recents | Correct number/contact binding; no disabled-call bypass | Planned/unverified |
| CF-019 | Caller ID selection; stale remembered ID; empty/error/retry inventory; coach preference | Valid organizational caller ID only; preference/state coherent | Planned/unverified |
| CF-020 | Simulated live mute/unmute; keypad; hold/resume; hold with keypad open; reconnect; hangup; microphone denial | Transport/state agree; DTMF disabled held/not-live; clear recovery | Planned/unverified |
| CF-021 | Simulated active call navigation/refresh/header reopen/provider disconnect | One retained session with correct lead/time; no duplicate initiation | Planned/unverified |
| CF-022 | Wrap-up empty/whitespace/long required notes; each disposition from dispositions.ts; teardown-unconfirmed and retry | Outcome gated on notes/confirmed teardown; correct single note/outcome | Planned/unverified |
| CF-023 | Wrap callback Today PM/Tomorrow AM/custom datetime; missing/past custom time; Cancel; repeated Schedule | Correct one callback; cancel no task; no stale lead binding | Planned/unverified |

## Nested Open lead scope

These cases are reachable after leaving My Leads for the canonical lead workspace. Report them separately from direct-page completion. No external provider sends, calls, reminders, notifications, signature requests, live enrollments or paid enrichment may execute.

| Case ID | Surface/actions and adversarial variations | Expected oracle | Status |
|---|---|---|---|
| OL-001 | Previous/next record and empty neighbor boundary; deleted/inaccessible lead; browser Back | Correct record; meaningful forbidden/not-found/load-failure distinction | Planned/unverified |
| OL-002 | Assignee self/other/current no-op/Unassign; inactive historical owner; empty/error roster; optimistic failure; two tabs | Rollback failed change; correct rep queue movement; historical attribution preserved | Planned/unverified |
| OL-003 | Status New Lead/Contacted/Offer Sent/Offer Declined/Interested/Under Contract/Closed/Dead; same no-op; stale conflict | Shared status and queue projection coherent; failed optimistic change rolls back | Planned/unverified |
| OL-004 | Move back to Prospect confirmation reject/accept | Qualifying fields cleared only on accepted successful revert; leads membership correct | Planned/unverified |
| OL-005 | Create Follow-up/Callback; due datetime; owner self/other; no/inactive/failed roster; past time; rapid repeat | Correct task property/type/owner/due; nearest action agrees across surfaces | Planned/unverified |
| OL-006 | SMS modal open/cancel/reopen; Send from choices; template selection; message empty/whitespace/1600/1601; Unicode; Send vs Queue under inert provider | Exact intended route/body; queued outcome not sent; one row; draft retained on error | Planned/unverified |
| OL-007 | Inline reply Cmd/Ctrl+Enter; template draft replacement confirm accept/reject; 2000-char boundary; alternate thread phone | Correct historic customer/business pair; no duplicate; server limits understood | Planned/unverified |
| OL-008 | SMS no contact/phone; opt-out another slot; consent unknown/error; quiet hours; provider off/failure; terminal/DNC; stale contact | Fail closed; no provider invocation; truthful blocked state | Planned/unverified |
| OL-009 | Signature preflight loading/failure/retry; blockers; empty templates; switch template and role fields | Correct eligibility/roles; no stale template values | Planned/unverified |
| OL-010 | Signature signer name/email per role; seller/property/offer price/closing date/earnest money; invalid/extreme values; cancel/reopen/pending Escape | Validated payload; safe close behavior; correct template/signers/merge values | Planned/unverified |
| OL-011 | Simulated signature send double activation/ambiguous response/retry | One logical envelope/request with retained recoverable history | Planned/unverified |
| OL-012 | Contract View/Download; reminder/void/retry/fix email and resend/confirm not sent; confirmation cancel/accept/pending | Status-dependent actions; correct signer; retry preserves failed row; no real provider action | Planned/unverified |
| OL-013 | File download empty/error/available/stale/unauthorized link; long filename | Correct authorized file or meaningful failure | Planned/unverified |
| OL-014 | Sequence picker empty/error/choices; simulated enroll/duplicate/resume/cancel confirmation; stale terminal/DNC | One correct enrollment; cancelled/resumed state; zero message execution | Planned/unverified |
| OL-015 | AI responder/skip-trace toggles; enrichment/preflight/CASS; pending repeat/failure rollback | Correct settings; gated training/DNC controls; zero paid/provider effects | Planned/unverified |
| OL-016 | Tags existing suggestion/create/Enter/Escape/remove; whitespace/case/duplicate/long; stale suggestions | Correct association and normalized uniqueness; intended removal only | Planned/unverified |
| OL-017 | Synthetic delete native confirm reject/accept; stale second tab | Intended disposable record only; clear stale state afterward | Planned/unverified |
| OL-018 | Permanent DNC detail, training detail, keyboard access to disabled controls | DNC read-only/history retained; training cannot invoke providers through hidden controls | Planned/unverified |

## Prioritized hypotheses, not reproduced defects

1. Booking overlap async responses have no generation/cancellation guard after issuance; an older response could overwrite current warning.
2. Assignee change starts timezone lookup without immediately clearing previous timezone; rapid submit may use stale timezone. Server behavior must be tested before claiming persistence corruption.
3. Schedule-next-step wrapper is fixed-position div, not Dialog; test background actions, focus, switching lead and mobile geometry.
4. Queue Call directly invokes softphone.openLead; do not treat it as a harmless modal probe on real leads.
5. Note composer pending guard has no client idempotency key; examine shortcut/button race and uncertain-response retry.
6. SMS modal limit is 1600, inline reply limit 2000; verify server acceptance/validation for both.
7. Full-lead navigation acknowledges unread SMS; navigation itself has a write side effect.

## Source map

Paths relative to current worktree:

- `src/app/(dashboard)/my-leads/client.tsx:70` call dispatch; `:137` schedule wrapper.
- `src/app/(dashboard)/my-leads/_components/detail-panel.tsx` notes/recordings/paging/actions.
- `src/app/(dashboard)/my-leads/_components/existing-detail-actions.tsx` canonical appointment/task reuse.
- `src/components/appointments/book-appointment-popover.tsx` fields, timezone/overlap and idempotency.
- `src/components/appointments/book-appointment-action.ts:276` RPC, calendar/notification/enrollment effects.
- `src/components/appointments/appointment-outcome-row.tsx` and `lifecycle-actions.ts` outcomes/confirmations.
- `src/app/(dashboard)/dashboard/_components/task-actions-row.tsx` Done/Snooze.
- `src/app/(dashboard)/leads/[id]/notes-feed.tsx:114` composer.
- `src/components/softphone/softphone-provider.tsx:990` dialer; `:1056` idle; `:1139` wrap.
- `src/lib/dialer/dispositions.ts` exact simulated disposition variants.
- `src/app/(dashboard)/leads/[id]/page.tsx` connected controls, unread acknowledgement and training/DNC gates.
- Same lead directory: `assignee-widget.tsx`, `status-widget.tsx`, `lead-task-widget.tsx`, `sms-composer.tsx`, `inline-reply.tsx`, `send-for-signature.tsx`, `contract-actions.tsx`, `lead-files-card.tsx`, `enroll-widget.tsx`, `tags-section.tsx`, `delete-lead-button.tsx`.
