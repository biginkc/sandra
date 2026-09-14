# My Leads page and workflow modal stress inventory

Candidate inspected: `65c58eb0` (current main including #526/#527). This inventory is derived from source and PRD, not a browser execution receipt. **Every case below is PLANNED.** Root records executions and confirmed findings separately in [FINDINGS.md](FINDINGS.md). Fixtures must be dedicated synthetic leads; no real customer calls or destructive business-record actions are implied by the inventory.

## Evidence and limits

Source root: `src/app/(dashboard)/my-leads/`; queue controls in `_components/queue.tsx`; stage actions in `_components/queue-row.tsx`; fetching, role controls and submission envelope in `client.tsx`; modal implementations in their named `*-dialog.tsx`; shared form handling in `_components/workflow-form.tsx`; shared validation in `src/lib/my-leads/validation.ts`. PRD: `docs/my-leads/PRD.md`.

Connected call, booking, callback, appointment lifecycle and note/template internals are covered by the companion inventory. This document includes their page entry points and integration expectations.

Source hypotheses (unverified by this researcher):

- H-PAGE-01: `client.tsx:58` clears snapshot/KPIs immediately on search changes, unmounting the input before the 250ms fetch. Character-by-character typing may lose focus. Root owns live evidence in FINDINGS.md.
- H-ATT-01: attempt dialog starts Kind=Call; switching Source to Manual preserves it and exposes a Call option. SQL `20260912101000_acquisition_manual_attempts.sql:24` accepts only DialPad+call or manual+outreach. Default Manual submission may always fail.
- H-MOD-01: modal captures row episode/version/shared status at open; page Refresh does not refresh that captured row. A stale rejection may remain unrecoverable without closing/reopening.
- H-PAGE-02: Expand all does not open collapsed stages, but still loads their hidden row details. Section collapse unmounts note composers and may silently lose drafts.
- H-MOD-02: submit closes dialog before awaited refresh. A post-write refresh failure may obscure whether the mutation succeeded.

## Action visibility baseline

Actions are visible only in expanded rows. Owner/member write authorization is enforced server-side, not by stage-button role checks.

| Stage | Primary | Secondary |
|---|---|---|
| Not contacted | Start call | Log attempt; Contract signed; Handoff |
| Contacted | Ready to make an offer | Start call; Log attempt; Log offer; Contract signed; Schedule next step; Handoff |
| Needs offer / Interested | Log offer | Start call; Log attempt; Contract signed; Handoff |
| Offer Sent | Contract signed | Start call; Log attempt; Offer declined; Handoff |
| Under Contract | Archive | None |

All expanded rows have Open lead and conditional Open in Zillow. The five-stage progress ladder is informational. No new implied stage prerequisite is permitted.

## Page controls (all PLANNED)

| ID | Action / adversarial sequence | Expected evidence |
|---|---|---|
| PAGE-001 | Initial load for owner, assigned member, member without Acquisitions designation/history, and disabled organization | Correct access, five ordered sections or explicit disabled/access state; no fabricated data |
| PAGE-002 | Owner selector across active enabled, disabled with history, and self | Label, rows and KPIs consistently scoped; member has no selector |
| PAGE-003 | Rapidly alternate owner selector while requests outstanding | Old responses never overwrite current scope |
| PAGE-004 | Today, week, month, custom range | KPIs change by event period; active queue and Under Contract inclusion remain independent |
| PAGE-005 | Custom range blank, one-sided, reversed, invalid date, same day, leap day | Incomplete suppresses request; invalid displays correction; valid same-day succeeds |
| PAGE-006 | Type date segments, clear a date, switch custom to preset and back | Controls remain operable; no stale range interpretation |
| PAGE-007 | Very wide custom range and Central midnight/DST boundaries | Stable load, correct inclusive/exclusive boundary semantics |
| PAGE-008 | Search with real sequential keypresses, backspace, clear and paste | Search focus/value retained, latest result only; exercise H-PAGE-01 |
| PAGE-009 | Search name/address/formatted and unformatted phone | Correct rows and filtered counts; KPI totals remain rep-period based |
| PAGE-010 | Search whitespace, apostrophe, Unicode, punctuation, wildcard-like strings, very long query, no match | Safe handling, honest empty state, no scope leakage |
| PAGE-011 | Search rapidly then change member/period during loading | Late results discarded; controls and labels recover |
| PAGE-012 | Toggle each stage by click, Enter and Space | Correct aria-expanded/controls; hides rows/actions from keyboard and accessibility tree |
| PAGE-013 | Expand row by summary click, Enter and Space, repeat rapidly | Correct aria state, at most intended detail fetches; no duplicate UI |
| PAGE-014 | Expand all with >3 loaded rows | Loaded rows only; max3 concurrent detail reads |
| PAGE-015 | Immediately Collapse all during expand-all reads | Waiting reads stop; no re-expansion from late responses |
| PAGE-016 | Collapse stage during reads; Expand all with stages collapsed; reopen stage | Document exact control semantics; no unexpected data/draft loss; exercise H-PAGE-02 |
| PAGE-017 | Load more after Expand all | Newly loaded rows handled consistently; no unbounded detail fanout |
| PAGE-018 | Per-stage Load more double click, exhausted cursor, duplicate rows, empty next page | Loading button disabled, dedupe, no skipped/duplicate leads |
| PAGE-019 | Load more then change search/member or background refresh | Old cursor response cannot corrupt new scope |
| PAGE-020 | Detail initial failure then Retry; repeated Retry | Recover with bounded requests and no duplicate records |
| PAGE-021 | Independently paginate notes, attempts, appointments, offers, history; parallel groups | Correct group/cursor, dedupe, loading/error localized |
| PAGE-022 | Detail-page failure then retry; collapse/change scope before response | No stale group appended to another lead or scope |
| PAGE-023 | Collapse row/section with dirty note, reopen; scope change with dirty note | Characterize draft preservation or explicit loss warning; no cross-lead draft leakage |
| PAGE-024 | Open lead then browser Back | Correct shared property; usable restored queue |
| PAGE-025 | Zillow and Recording links, missing/malformed/long URLs | Correct target, safe supported protocol, new tab/opener isolation; absent link honest |
| PAGE-026 | Page fetch failure then Refresh, offline then online, invalid custom range then Refresh | Clear recoverable state and no permanent spinner |
| PAGE-027 | Background focus/visibility refresh with dirty modal/note | No unwanted draft loss or mutation-target change |
| PAGE-028 | Warning timer crosses threshold while visible and while tab hidden | Refresh catches correct warning without changing records |
| PAGE-029 | All collapsed and expanded rows on mobile, desktop,200% zoom with long labels | No clipped controls/text; all content reachable; keyboard sequence sensible |
| PAGE-030 | Empty and paginated attempts/notes/appointments/offers/history | Correct newest-first order, empty labels, loaded count versus total distinction |
| PAGE-031 | Start call with disabled calling, no phone, DNC contact, enabled controlled fixture | Disabled/error behavior protects dialing; opening alone changes no clock/count |
| PAGE-032 | Schedule next step entry from Contacted, inner popover cancel, outer Close | Correct property/member, no duplicate booking or hidden dangling popover |

## Owner controls (all PLANNED)

| ID | Action / adversarial sequence | Expected evidence |
|---|---|---|
| OWNER-001 | Open/close Manage Acquisitions; inspect as non-owner | Owner-only controls and accessible disclosure |
| OWNER-002 | Toggle designation on/off, repeat rapidly, self-disable | Busy protection, durable correct state; historical events retained |
| OWNER-003 | Concurrent designation edit or stale expectedEnabled | Clear conflict, no silent overwrite |
| OWNER-004 | Recipient empty/select/save same value/different active member/self/non-Acquisitions member | Disabled empty save; valid configured choice durable |
| OWNER-005 | Recipient deactivated or settings changed after selection | Conflict/unavailable handled; no invalid handoff configuration |
| OWNER-006 | Save recipient then immediately hand off from already-open modal | Stale settings safely rejected or explicit current-recipient semantics |

## Common modal protocol (apply each case to attempt, readiness, offer, contract, decline, handoff, archive; all PLANNED)

| ID | Action / adversarial sequence | Expected evidence |
|---|---|---|
| MOD-001 | Open then Cancel, close icon, Escape, overlay click | No mutation, fields/errors reset on reopen |
| MOD-002 | Dirty cancel/reopen same lead then different lead | No cross-lead state leakage; correct initial values |
| MOD-003 | Submit all blank then correct fields | Accessible field errors; correction succeeds without reopening |
| MOD-004 | Valid Save double click, Enter twice, click+Enter | Exactly one durable command/event; busy button state |
| MOD-005 | Save then Escape/Cancel/close icon while request delayed | Pending close prevented consistently; no ambiguous abandonment |
| MOD-006 | Edit fields during pending save | Saved payload matches submitted snapshot; no false visible confirmation |
| MOD-007 | Server rejects then retry same values; change values then retry | Draft retained, clear error; same payload reuses key, changed payload gets new key |
| MOD-008 | Commit succeeds but response lost; retry same payload | Exactly one durable write/count; no duplicate side effect |
| MOD-009 | Successful write followed by refresh failure | Persisted result discoverable, no duplicate re-entry; H-MOD-02 |
| MOD-010 | Another tab changes stage/assignment/status while modal open; Save then page Refresh then retry | Safe stale error, practical recovery; H-MOD-01 |
| MOD-011 | Keyboard focus trap/return, screen reader name/errors, long title, mobile,200% zoom | Every field/action accessible; footer reachable; errors visible |
| MOD-012 | Datetime blank, invalid, Central DST nonexistent/repeated hour, midnight; OS timezone differs | Central conversion correct and impossible time rejected |
| MOD-013 | Auth expires, membership revoked, DNC or archive applied while open | Server rejects unauthorized mutation atomically; draft/recovery clear |

## Attempt dialog (all PLANNED)

| ID | Case | Expected evidence |
|---|---|---|
| ATT-001 | DialPad each outcome: No answer, Reached, Wrong number | One attempt with actual occurrence time, actor and correct KPI numerator/denominator |
| ATT-002 | Source Manual outreach with default Kind then explicit Other outreach | H-ATT-01 reproduced or refuted; valid non-call outreach advances Contacted without first-call evidence |
| ATT-003 | Toggle source Sandra→Manual→DialPad repeatedly; switch kinds | Hidden stale fields cannot yield invalid or misattributed payload |
| ATT-004 | Sandra no references, delayed references, load failure, several references | Honest empty/loading/error, correct verified selection |
| ATT-005 | Sandra already finalized/stale call reference; same call finalized in second tab | No duplicate attempt; useful conflict handling |
| ATT-006 | Occurrence future, historical before assignment, after assignment, earlier than prior logged call | Future rejected; episode/first-call timing correct and earliest qualifying call retained |
| ATT-007 | Recording blank, validHTTP/HTTPS, invalid syntax, ftp, embedded whitespace, >4096chars | Optional blank accepted; unsupported URL rejected safely, useful error |
| ATT-008 | Note whitespace, multiline, Unicode, long text | Trim/preserve intended content; visible shared context or explicitly documented limitation |
| ATT-009 | Log call on Needs offer and Offer Sent | No advanced-stage regression; event increments once |
| ATT-010 | Open/cancel attempt repeatedly | No event, timestamp, stage, or KPI mutation |

## Readiness dialog (all PLANNED)

| ID | Case | Expected evidence |
|---|---|---|
| READY-001 | Specified motivation blank/whitespace/10,000chars/10,001chars | Required meaningful text; documented maximum enforced |
| READY-002 | Type motivation→No motivation provided→specified | No-motivation clears text; return requires response; explicit none distinct from unanswered |
| READY-003 | Temperature unchanged/hot/warm/cold with both motivation responses | Existing temperature retained when unchanged; no invented temperature |
| READY-004 | Save without any appointment | Needs offer and shared Interested; starts one offer-needed clock |
| READY-005 | Concurrent readiness/offer/contract change | No regression, duplicate milestone or reset of timer on stale replay |

## Offer dialog (all PLANNED)

| ID | Case | Expected evidence |
|---|---|---|
| OFFER-001 | Amount blank,0,negative,.50,1.,1.001,commas,$,exponent,unsafe integer | Positive decimal with ≤2places only; clear error |
| OFFER-002 | Amount0.01,1.2,leading zeros,trimmed decimal | Exact integer cents persisted, no floating rounding |
| OFFER-003 | Verbal/email-text/Dropbox Sign each | Log only; no contract send, provider call, task or calendar creation |
| OFFER-004 | Sent missing/future; follow-up missing/equal/before sent | Required coherent dates, future event handling from server |
| OFFER-005 | Historical sent and follow-up already overdue | Valid if follow-up>sent; warning shown, no invented future task |
| OFFER-006 | Missing motivation: both response modes and all READY validation bounds | Required on direct offer, no appointment/readiness prerequisite |
| OFFER-007 | Existing motivation plus temperature unchanged/each value | Existing response retained, not cleared by null payload |
| OFFER-008 | Another pending offer created during open dialog | Atomic rejection; no second pending offer |
| OFFER-009 | Successful offer then refresh/reopen/Open lead/KPI period change | Stage Offer Sent, shared milestone, correct method/cents/original actor/sent time |

## Lifecycle dialogs (all PLANNED)

| ID | Case | Expected evidence |
|---|---|---|
| LIFE-001 | Contract signed: blank/future/invalid time | Valid event timestamp required; meaningful rejection |
| LIFE-002 | Contract: no offer ID, valid matching offer, malformed UUID, other property/org ID, resolved offer | Optional no-offer path works; wrong references rejected atomically |
| LIFE-003 | Direct contract from Not contacted/Contacted/Needs offer/Offer Sent | Under Contract allowed without artificial prerequisites or fabricated call/offer |
| LIFE-004 | Contract then change KPI period, reload, inspect shared lead | Remains Under Contract, never silently Closed/archived |
| LIFE-005 | Decline: pending offer present/missing/already resolved; invalid/future/before-offer time | Correct offer targeted; invalid/stale rejected |
| LIFE-006 | Decline with missing/deactivated/concurrently changed recipient | No partial decline/reassignment; practical owner-settings recovery |
| LIFE-007 | Successful decline | Offer outcome, Needs sequence, reassignment/removal/history atomic; no enrollment/task |
| LIFE-008 | Handoff blank reason/recipient; Not interested and Needs nurture | Required values; configured recipient only |
| LIFE-009 | Handoff self-recipient/stale recipient/stale assignment | Intended server policy enforced, no partial handoff |
| LIFE-010 | Successful handoff then recipient reassigns back | History retained, new assignment episode correct, old timer not borrowed |
| LIFE-011 | Archive unchecked→checked→unchecked; cancel/reopen | Explicit fresh confirmation required |
| LIFE-012 | Archive concurrent status/reassignment/already archived | Safe stale/idempotent result; no unintended shared status |
| LIFE-013 | Successful archive then refresh/Open lead | Removed active queue; Under Contract/history preserved, not Closed/Dead |

## Cross-action destructive probes (all PLANNED)

| ID | Sequence | Expected evidence |
|---|---|---|
| RACE-001 | TabA attempt open; tabB handoff; tabA submit | Stale assignment rejection; no event attached to wrong episode |
| RACE-002 | TabA offer open; tabB logs offer; tabA submit | At most one pending offer |
| RACE-003 | TabA decline open; tabB signs contract; tabA submit | No declined contract or reassignment |
| RACE-004 | TabA archive open; tabB changes lifecycle; tabA submit | No stale destructive write |
| RACE-005 | Owner viewing rep records attempt/offer | Performer attribution remains actual actor, not selected rep |
| RACE-006 | Historical call before current episode then new qualifying call | Attempts retained; current clock only stopped by valid episode evidence |
| RACE-007 | First attempt→direct offer→signed contract→archive, refreshing after each | Complete journey persists correctly in My Leads and Leads, no invented intermediate tasks |
| RACE-008 | Readiness→attempt→offer→attempt→contract | Later attempts never regress queue/shared status |
| RACE-009 | In-flight detail pagination plus mutation that moves row | No stale detail into different stage/property or duplicate history |

## Execution bookkeeping

For each executed case record: candidate SHA, environment and identity/role, synthetic property ID, initial state, exact browser action, observed UI, durable corroboration, screenshot/evidence link, result PASS/FAIL/BLOCKED, cleanup and retest reference. A toast or isolated mock callback alone does not prove persistence. Source hypotheses above are not counted as executed failures. Exhaustive means every listed control/branch is accounted for; it does not mean an infinite combination space has been proved safe.
