# My Leads executable workflow testing plan

Status: READY FOR ENVIRONMENT PREFLIGHT; no new execution is claimed.
Scope: 26 journeys decomposed into 84 independently tracked scenarios in WORKFLOW-TEST-CASES.csv. Journey steps and expected outcomes live in FABLE-USER-WORKFLOWS-20260912.md; apply its corrections and the PRD authority rules below. This plan supplements the prior campaign rather than replacing historical receipts.

## What qualifies as a test

Every CSV row is an execution unit. Before running it, bind an exact candidate, browser identity, disposable fixture ID, initial state, concrete input values and expected persisted delta. Use the source journey for steps; record the actual steps in the receipt. A main path passing does not pass its interruption branches. Do not fill expected results from observed behavior.

A completed write test requires: baseline -> real browser actions -> visible result -> full reload/reopen -> corroborating read of persisted facts -> unexpected-side-effect check -> fixture cleanup evidence. Opening/cancelling a dialog proves only that interaction. Database setup and assertions are supplementary evidence, never browser execution.

## Authority and corrections before execution

`docs/my-leads/PRD.md` §§3–11 defines product expectations; Fable suggestions do not override it. Current user excludes mobile and Maria. Current user has retained the shared E2E bypass; unit/component checks and this campaign are still required.

- Any qualifying outreach, including No answer, advances a fresh lead to Contacted. Non-call outreach cannot satisfy the first-call clock. Reached/all counted attempts defines Contact rate.
- A decline records Offer Declined, Needs sequence and configured recipient reassignment atomically. A handoff exits the active queue; do not assume immediate recipient My Leads visibility or a revised-offer action. J04's re-entry branch remains BLOCKED until the supported prerequisite is established, and J08 must run materialized and fresh implicit/version-0 handoff fixtures independently.
- Stage skips are allowed; arbitrary Leads status changes do not imply reverse synchronization into queue stages. Advanced statuses cannot silently regress.
- Offer logging records an already-made offer. Dropbox Sign is a method label, not a send. No implicit task/calendar/enrollment creation.
- Contract signed is Under Contract, not Closed. Archive retains history.
- Manual outreach was fixed already; test the current valid path rather than expecting its old failure. Completed appointments and deliberate draft cancellation must not be assigned invented behavior.

## Preflight — required before browser writes

1. Record UTC run ID, inspected branch/head/tree, dirty file manifest, PRD revision and local app build identity. Refresh relevant main/deployment references read-only; explicitly state which candidate is being tested. Prior a9021cfe and ports are historical observations, not a current-environment guarantee.
2. Inspect existing local processes and fixture ownership. Reuse the dedicated My Leads local stack only after proving API and database identity and exclusive ownership of new fixtures. DATA-AND-ENVIRONMENT.md documents historical 58321/58322 and Colima isolation. Never reset it merely to get a clean starting point. Shared environments require current Tester admission; avoid them for this campaign.
3. Serve a verified production build with next start on an available owned port. The prior development server had an unresolved interaction/transport problem; do not equate that observation with a proven root cause or introduce a dev-mode difference into candidate acceptance. Record the actual URL. Smoke-check authenticated stage toggle, search and modal before seeding the campaign.
4. Verify no copied remote environment files, live provider credentials, external workers or notification delivery. Prove inert adapters for booking/calendar/enrollment paths. Provider-dependent branches without that proof are BLOCKED.
5. Inventory synthetic roles. Existing foreign-org identities are not a same-org rep B. TEAM and TEAM_HISTORY need an enabled same-org rep B plus a non-designated/disabled-history member: create only within the verified owned local fixture scope, tracking identity cleanup; otherwise BLOCK those branches. Reuse the synthetic owner/rep and separate foreign-org users for authorization checks. Never use Maria.
6. Announce shared browser control, start the indicator and wait three seconds before mouse/keyboard actions. Release it on completion or a browser blocker. Keep separate authenticated contexts for owner, reps and foreign user; no session/cookie export.
7. Write a fixture manifest with property/episode/event/task IDs, organization, assignee, explicit timestamps, expected stage/status/metrics and before counts. Use separate records for incompatible terminal outcomes; test dependencies are fixture facts, not an assumption that a prior journey happened to pass.

## Fixture families

| Family | Required state and isolation |
| --- | --- |
| FRESH / CONTACTED / READY | Explicit eligible assignment, zero or known outreach, known motivation, no hidden next steps |
| OFFER / OFFER_DUE / ADVANCED | One known pending offer, exact cents/actor/sent/follow-up, explicit stage-entry time; separate contract/archive/decline records |
| HANDOFF / STALE | Known configured recipient, assignment version/episode, independently authenticated second actor |
| APPOINTMENT / CALLBACK | Canonical task IDs/due/end/assignee, separate future/past/held/no-show/cancel/reschedule fixtures, inert delivery effects |
| CLOCK / HISTORICAL | Explicit Central and UTC timestamps and server reference instant; authoritative boundary fixture support, no system-clock changes |
| TEAM / TEAM_HISTORY / EMPTY | Same-org owner and two reps, non-designated member, foreign identities, known per-actor metric totals |
| SIMILAR / HISTORY | Distinct similar names/addresses, more than one history/list page, deterministic identity labels and no unread SMS |
| AUTH / FAULT / SUPPRESSION | Disposable isolated sessions/records; supported revocation/fault setup; canonical DNC/wrong-number rules |

Before each scenario create or restore only its owned fixture through guarded setup and prove the baseline. Do not reset the database between tests. Capture legitimate writes as part of the evidence; remove only ledger-owned fixtures when complete, preserving prior campaign data.

## Ordered execution

| Batch | Journeys | Exit condition |
| --- | --- | --- |
| 1 — core saved workflows | J1, J2, J3, J5, J14, J16, J17 | Attempts, readiness, offers, signatures-as-records and archive have correct persisted outcomes; no regression or implicit sends/tasks |
| 2 — ownership and metrics | J4, J8, J9, J12, J20, J21 | Atomic queue exits, permissions, same-org reassignment and historical attribution; separate blocked re-entry assumptions |
| 3 — daily follow-up | J6, J7, J13, J15, J18, J19 | Correct working/elapsed clocks, date attribution and future-next-step behavior with controlled scheduling effects |
| 4 — interruptions and identity | J10, J11, J22, J23, J24, J25, J26 | No wrong-record writes, unauthorized actions, duplicate commits or unrecoverable saved-state ambiguity |

Complete each batch's independent cases even if one fixture is blocked. A core failure pauses only dependent cases or writes whose safety is uncertain; record the blocker and continue unrelated useful tests. Do not claim all 26 complete until every required child case has a terminal evidenced outcome.

## Test methods and evidence

- Real in-app browser: input, controls, submissions, focus, error recovery, navigation, reload and visible state. The current browser skill governs automation; do not substitute a hidden harness for a claimed in-app test.
- Read-only database/API verification: exact rows, original actor, episode, cents/time, deduplication and side-effect deltas. Direct authorization probes are labeled API tests separately.
- Controlled harness: server-time boundary fixtures and scoped pre/post-commit faults. Confirm commit before calling anything a lost-response scenario. Client clock spoofing alone cannot prove server warning logic. Unsupported fault injection is BLOCKED.
- Unit/component/integration regressions: supplement browser evidence, especially races and precise clocks. They do not replace the user journey or prove live providers.
- Production/local distinction: this campaign proves the recorded local candidate with synthetic auth. It does not prove production Hugo login, real calling or external delivery. Any later production smoke must be separately scoped and labeled.

Receipt path: `evidence/workflows/<run-id>/<case-id>.md`. Use WORKFLOW-TEST-RECEIPT.md as the template. Screenshots should show relevant state without credentials; a screenshot alone does not establish persistence.

## Results, triage and completion

Allowed case states: NOT RUN, RUNNING, PASS, FAIL, BLOCKED. Only PASS has both expected behavior and required evidence. BLOCKED includes the exact missing capability/fixture and next action. A case may not be silently waived; any explicit user scope exclusion is recorded separately from status.

Classify findings by business consequence: P0 authorization/wrong-record/data-loss/unintended external effects; P1 approved core workflow blocked or incorrect persisted state; P2 nonblocking behavior/polish. Keep original journey priority separate from defect severity. Record reproduction, expected/actual, candidate, fixture, smallest affected flow and evidence in FINDINGS.md. Follow current ownership/review rules for confirmed in-scope fixes; no speculative refactor. After a fix, rerun the exact failure and neighboring flows plus appropriate automated checks on the changed candidate. Earlier evidence on an unchanged behavior may be referenced explicitly, never silently relabeled as the new head.

Finish with totals from the CSV, unresolved failures and blockers, exact candidate, reviewed fix references if any, cleanup proof and released browser control. Readiness requires all required P0/P1 scenarios to pass and no unresolved blocking product issue; blocked coverage prevents claiming exhaustive readiness. Preserve any independent release/CI gates. This planning task does not merge or deploy anything.
