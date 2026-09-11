# My Leads — verification and release contract

> **Execution amendment from Jarrad:** This feature task is fully isolated. Use built-in agents only; do not dispatch through or depend on Sandra Orchestrator, Messenger, or controller. Historical shared-coordination references below do not apply to this execution. Preserve actual authorization, account/provider limits, native CI, migration/deployment checks, and other worktrees. See [local acceptance](LOCAL-ACCEPTANCE.md).

Planning baseline: PRD v0.2, main `8c7053e7024433f46791eac1b186c1b7a7cf10ec`. Commands below are future execution instructions, not a report of tests run. Research/documentation work starts no provider calls, migrations, campaigns, shared tests, or deployments.

## 1. Test layers and actual repository selectors

| Layer | Existing selection | Future command | Writes / admission |
|---|---|---|---|
| Domain and action unit tests | `src/**/*.test.ts`, excludes integration | `npm run test -- src/lib/my-leads 'src/app/(dashboard)/my-leads'` | Mocked/data-free; no shared admission needed. |
| Component tests | `src/**/*.test.tsx` under jsdom | `npm run test:rtl -- 'src/app/(dashboard)/my-leads'` | Mock actions; no DB writes. |
| Typecheck | Project TypeScript config | `npm run typecheck` | Local check. |
| Focused SQL/RLS integration | `src/**/*.integration.test.ts` and `supabase/migrations/**/*.integration.test.ts` | `npm run test:integration -- src/lib/my-leads 'src/app/(dashboard)/my-leads'` | REAL database; Tester must approve effective physical target, fixture lifecycle and lock. |
| Authenticated browser | `e2e/*.spec.ts` through default config | `npm run test:e2e -- e2e/my-leads.spec.ts --project=chromium` | Includes setup/global hooks; admission required, even with a single spec. |
| Native CI | `.github/workflows/verify.yml` and existing migration/E2E/Coach workflows | Existing required workflows; preserve their commands | Inspect all push/PR-triggered writers before publishing. |

`npm run verify` includes PostgreSQL-dependent eSign rehearsals before TypeScript/unit/RTL. It is not a database-free alias. Run on the approved isolated local PG17 environment or through native CI with admission as required; never substitute production credentials.

Proposed paths are deliverables, not existing tests. A packet is not verified by a command reporting “no tests found.” Record actual discovered test count, exit status and relevant output. Packet commands must also name any new migration-adjacent integration files explicitly; source-directory filters do not include `supabase/migrations` tests. Shared-file changes also run focused neighboring existing tests; avoid rerunning the entire unrelated application matrix after every small packet.

## 2. Account and data budget

Use at most FOUR test accounts TOTAL across this acceptance campaign and all environments, preferring THREE existing safe accounts:

1. Organization A owner, not initially Acquisitions; surrogate for the configured handoff recipient.
2. Organization A member, Acquisitions; surrogate for Maria.
3. Organization B member; cross-tenant rejection proof.

Reuse account 2 with its designation disabled for non-Acquisitions timing tests, restoring it afterward. If a second Organization A rep is indispensable for reassignment proof, reuse/admit one fourth account; do not create one account per test, worker, retry, PR or environment. Owner can act as a second eligible rep in a controlled fixture with the designation restored afterward when three accounts suffice.

Use a small owned fixture set (approximately ten leads), with explicit organization, actor, property, appointment and offer identities. Do not contact actual sellers. Avoid whole-tenant truncation for this feature’s own fixtures. Existing global test hooks and helpers must be inventoried before use: `tests/integration/fixtures/multi-user.ts` creates/deletes accounts, and the broader integration/E2E suites contain reset hooks. File filtering is not isolation or account-budget proof.

Browser contexts isolate authentication storage, not the shared database. Use separate owner/member/foreign-member contexts backed by the same approved fixture ledger; do not rely on private windows as data isolation. [Playwright authentication](https://playwright.dev/docs/auth), [browser context isolation](https://playwright.dev/docs/browser-contexts).

## 3. Required test cases

### Domain transitions and first-call evidence — PRD 3, 4, 5, 6, 7

- Five public labels; no separate Follow-up or Won stage.
- First placed call advances a fresh queue entry and updates New Lead to Contacted. Existing Interested, Offer Sent, Under Contract and terminal statuses are not demoted by a later call.
- Opening/cancelling call UI, Jitter session creation, operator connect, RTC registration and a provider setup rejection do not count. Actual placed-but-unanswered call does count. Map provider observations explicitly; do not infer initiation from completion or from a truthy UI promise alone.
- Non-call reach-out can establish Contacted without satisfying first-call time. External-call occurrence time is recorded explicitly.
- Duplicate callback/delivery and UI retry produce one attempt, one earliest qualifying first-call timestamp and one milestone. A manual outcome attached to an automatic call does not add an extra attempt.
- Motivation missing fails readiness/direct-offer action; structured No motivation provided succeeds without being mapped to hot/warm/cold.
- Direct offer and direct signed-contract journey work during a first call without forced appointment/stage clicks.
- Shared milestone updates are one-way explicit actions; editing a board status does not indiscriminately drive queue stage backward or forward.

### Timers — PRD 6 and 10

Use deterministic clock injection in pure functions and SQL fixtures. Production query time must come from the server, not arbitrary client `now` input. Use half-open daily working intervals [09:00,17:00) and elapsed timestamp boundaries.

| Scenario | Expected |
|---|---|
| Monday 09:00 assignment | No first-call warning at 09:29:59; warning at 09:30. |
| Friday 16:50 assignment | Warn Monday 09:20; never reset each day. |
| Monday 18:00 assignment | Start accumulating Tuesday 09:00; warn Tuesday 09:30. |
| Weekend assignment | Start Monday 09:00. |
| Friday before spring DST change, 16:50 Central | Monday warning still 09:20 Central despite UTC offset change. |
| Friday before fall DST change, 16:50 Central | Same local Monday boundary. |
| Call starts outside working hours | Stop first-call clock at the actual start timestamp. |
| Stage entry at 18:00 | Offer warning at 06:00 next day: 12 elapsed hours, not working hours. |
| Contacted, no valid future next step | Red immediately. Future scheduled callback/appointment clears it. |
| Completed/cancelled/past next step | Does not clear missing-future-step indicator. |
| Pending offer passes follow-up time | Overdue; signed/declined outcome removes that pending-offer condition. |
| Initial Maria cohort | No eligible first-call warning or assignment-to-call KPI, no invented activity. |

Calculate each local day boundary in America/Chicago; do not repeatedly add 24 hours or assume CST is fixed UTC−6. Test both business-minute warning output and elapsed-duration KPI independently.

### Atomicity, authorization and attribution — PRD 1, 2, 9, 13, 14, 15

- Unauthenticated, foreign-org, and member requesting another member’s queue/actions are rejected. Owner same-org selection succeeds. Never trust actor/org/role supplied by the browser.
- Designation changes require owner authority and do not change Owner/Member permissions. Disabled feature hides and rejects page/actions in other organizations.
- Two concurrent actions with the same idempotency key return the same logical result; different payload reuse is rejected. Race: reassignment vs an action from the previous rep produces either the valid serialized action or a typed stale-assignment rejection.
- Historical action attribution uses the performer, not the current property assignee. Assignment episodes are immutable history; a previous rep’s first call does not stop a new eligible episode’s clock.
- Decline records offer outcome, board Offer Declined, Needs sequence, reassignment and queue exit consistently. Inject failure to prove there is no success toast for half a handoff.
- Needs sequence alone does not enroll, send, schedule, or mark Dead. Assert absence of new enrollment/task/appointment/provider calls, not only presence of the new disposition.
- Permanent DNC, membership removal and existing assignment-safety guards continue to reject unsupported operations.
- Launch initialization handles only declared owned fixture cohort; rerun creates no extra episodes or timestamps and does not resurrect terminal/DNC leads.

A row lock serializes competing updates only for its transaction lifetime. Acquire rows in consistent order and re-check state/version after obtaining the lock; keep provider network work outside that transaction. [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html).

### KPI and pagination — PRD 2, 13, 16

- Ten-lead fixture with known outcomes, offers, appointments, pending calls and reassignment. Compare aggregate output to independent SQL totals, not the same function invoked twice.
- Owner and rep selecting the same rep/range get identical six tiles. Changing Day/Week/Month changes period tiles, not the current stale count.
- Count one stale lead despite two warning reasons. Unknown/pending call latency is not zero; zero-denominator rates are unavailable.
- Contacted means attempted; Contact rate numerator means Reached. A No answer attempt must not increase the numerator.
- Calls/offers stay credited to original rep after handoff. Creation timestamp vs occurrence/sent timestamp is exercised with a delayed manual log.
- Page counts use full eligible queue; loaded rows are bounded. No cross-stage cursor reuse, duplicates or omissions on equal-sort timestamps. Stable tie-breaker is property/queue ID.
- Expanded detail loads only on demand; switching member clears prior member rows, cached detail and totals before presenting the new data. Responses arriving out of order cannot replace a newer member selection.

## 4. Browser journeys

Run on an exact admitted preview candidate and synthetic data after review:

1. Member opens queue, sees initial cohort vs new assignment, receives the mocked authenticated actual seller-leg event with original call token/provider ID/occurrence time (or uses the separately approved provider path), logs optional-recording outcome, observes Contacted and the shared milestone.
2. In one journey: explicit motivation → offer with required follow-up → manually signed contract → Under Contract remains when changing date range → deliberate archive.
3. Member records offer declined; owner sees reassignment and Needs sequence, historical rep KPI remains, no new enrollment/task exists.
4. Owner toggles Acquisitions, selects member, compares KPI/query results; member and foreign-organization requests cannot impersonate that selection.
5. Timer fixture crosses first-call business boundary and offer elapsed boundary. Verify warning copy, color and accessible text, without waiting real minutes/hours.
6. Existing Leads detail, note composer, appointment booking and call recovery smoke remain functional. Visual check at desktop and narrow width/200% zoom, keyboard dialog operation and validation placement.

Provider transport mocks prove application wiring, not live calling. Any real provider verification remains a separately admitted existing test path with its spending/call limit; never improvise seller calls or claim a mocked provider run verifies production transport.

## 5. Review, shared admission and release

Follow the latest live orchestration documents at execution time. Current routing:

- Orchestrator `01a08cb5-e275-7070-8b50-e79d052cdef6` assigns feature scope and resolves source ownership.
- Tester `01a08e95-5183-7591-8e63-12ef5184fadc` admits new shared DB/browser operations after independent manual review and explicit current-candidate Astra Medium approval.
- Merge Controller `01a08cc7-5c47-79f0-a08a-7b9db97bf6dd` owns merge/release. Do not use the old controller.

Preserve at most three cumulative feature code-review/fix rounds; modular packets do not reset the feature counter. Beyond that, only Tester-browser-reproduced bugs blocking the approved feature justify more product fixes. Document unrelated/nonblocking findings rather than expand the feature.

Admission packet: head/base/tree, dirty manifest, approved PRD/plan, exact migration/API paths, dependency status, review receipts, physical target proof, every local/hosted/CI writer, account reuse/new totals, provider mode, fixture ownership, cleanup and rollback. Reservations cover setup through verified restoration and late callbacks. Unknown target/cleanup is not permission to reset.

Every PR declares dependencies. If it depends on unmerged work, use the required stacked base and reviewed parent; do not cherry-pick unreviewed owner work. An overlapping file alone is not necessarily a functional dependency; document which contract is actually needed.

After each merge, require healthy main CI and all required application deployment/migration verification before ANY next PR is admitted. `.github/workflows/db-migrate-prod.yml` follows a successful test-migration workflow from main; do not replace that route with a manual production SQL command. Preview pass is not production completion.

## 6. Rollback and acceptance receipt

Keep the organization feature flag off through schema/function installation. Disable it first if rollout fails. Preserve recorded attempts, offers and episodes; do not drop new tables or rewrite user activity as the default rollback. Revert bounded application code using normal release controls. Restore only explicitly owned test fixtures under the admitted cleanup plan. Launch cohort status changes require per-row prior-value evidence and concurrency checks for any compensating restoration; never overwrite a lead worked since launch.

Final receipt records deployed commit, applied migration identities, feature gate/org, designation and handoff configuration (no secrets), cohort count/exclusions, test accounts used, exact test results, remaining limitations, preview and production outcomes separately, and Tester restoration/release. Do not call implementation done from a clean typecheck or documentation approval alone.

## Contract-review regression cases

- Disable Maria’s designation with an active eligible episode: its clock and self/owner queue access remain; owner selector labels the designation disabled. A new assignment is ineligible. Re-enable without retroactive clock creation. Organization disable still gates operations.
- Cursor: all five initial stage tokens share one evaluation instant; expired, altered, cross-viewer, cross-member, cross-stage or changed-filter tokens fail and require refresh. Concurrent stage moves refresh the client and do not duplicate displayed IDs.
- Appointment: Jarrad books for Maria and later records held; due/held credit stays with Maria after property or task reassignment. Unknown historical booking attribution is excluded from the ratio and visibly counted unavailable.
