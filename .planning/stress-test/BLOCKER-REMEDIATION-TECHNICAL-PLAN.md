# My Leads blocked-case remediation — technical implementation plan

Date: 2026-09-13. Status: implementation and representative browser preflight in progress; full campaign not yet executed.
Scope: remove the technical obstacles recorded against 57 of 84 desktop cases, then execute a fresh full campaign. Preserve prior evidence and approved product behavior. Work only in the isolated worktree and synthetic local database.

## Evidence and corrections to previous diagnosis

The previous receipt records 27 PASS / 57 BLOCKED; BLOCKED includes partial execution, unavailable fixtures, tooling limitations, and unverified assumptions. It is not an audited list of 57 infrastructure failures.

Existing `e2e/my-leads.local.spec.ts` already authenticates disposable identities, creates independent browser contexts, converts Central wall time, and uses locator.fill for native datetime inputs in offer/contract flows. Its existence does not establish that it currently passes. Both that spec and `playwright.my-leads-local.config.ts` reject ports other than 58700; the prior candidate used 58702. The configuration also disables traces and has no runtime provisioning. These are concrete harness gaps.

`src/lib/my-leads/time.ts` already accepts an explicit now for warning evaluation. SQL queue helpers also accept time parameters, while command guards and public KPI functions use statement_timestamp(). Browser clock mocking alone therefore cannot prove server chronology. Do not add a production clock override as the default solution.

## 1. Reproducible local runtime and browser harness

Files: extend `playwright.my-leads-local.config.ts`; extract common setup from `e2e/my-leads.local.spec.ts` into proposed `e2e/my-leads/support/runtime.ts` and `identities.ts`; add proposed `scripts/my-leads-stress-runtime.mjs`.

- Record candidate SHA, schema migration inventory, run ID, app port, database endpoint and synthetic org in a manifest. Keep credential files outside version control and reports.
- Replace duplicate fixed-port checks with one strict loopback/owned-runtime manifest check. Reject remote app/database targets and mismatched runtime identities; do not simply remove guards.
- Extend testMatch to include `e2e/my-leads/**/*.spec.ts` as well as the existing local spec; tag actual preflight tests. Run `--list` and assert the expected inventory is nonempty before execution. Exclude the existing narrow-width test from this desktop campaign.
- Restore the dedicated local stack, verify schema and health, and start one candidate app. Fail preflight on missing dependencies, browser binary, auth, wrong database or wrong SHA.
- Run Chromium with one worker, no automatic retries initially, independent contexts per actor, desktop viewport. Capture failure screenshots and redacted diagnostic metadata; retain traces only with an artifact policy that excludes credentials/session material.
- Preserve the previous run's fixtures/evidence. New run uses fresh IDs and does not reset the entire database.

Acceptance: rep and owner sign in, queue renders, a disposable note persists and reloads; wrong target is refused. Proposed command after implementation: `npx playwright test --config=playwright.my-leads-local.config.ts --grep @preflight`.

## 2. Native date/time entry and chronology

Files: proposed `e2e/my-leads/support/datetime.ts`; offer, attempt and lifecycle specs. Existing UI: `src/app/(dashboard)/my-leads/_components/{offer-dialog,attempt-dialog,lifecycle-dialog}.tsx`.

- Start with Playwright locator.fill using YYYY-MM-DDTHH:mm and assert input value plus native validity before clicking the real Save button. Verify persisted UTC instant and queue state after reload. Do not call the mutation RPC as the action under test.
- Obtain database now during fixture setup; establish assignment before attempt/offer before contract/decline, with sufficient margin for minute precision and runtime latency. Use distinct fixtures per case.
- Cover empty/invalid/reversed dates, validation recovery, retained unrelated form values, duplicate Save, and two-context concurrent offers.
- If fill fails, retain trace of the exact control, inspect min/max/step, conversion and React validation, then test normal keyboard entry. Distinguish browser adapter limitation from a reproducible product defect before changing UI.

Acceptance: browser-only valid offer, contract and decline commits; invalid input causes zero writes; stored timestamps match explicit Central conversion. This unlocks most J03–J05, J14–J16 and J19 branches.

## 3. Deterministic fixture factory and actual lifecycle controls

Files: use `.planning/stress-test/seed-expanded.mjs` as reference; proposed `scripts/seed-my-leads-stress.mjs`, `e2e/my-leads/support/fixtures.ts` and per-case fixture manifest.

- Add namespaced rep A, rep B, empty rep, owner, disabled member with history and foreign-org identities. Assign explicit memberships and recipient settings.
- Keep actor membership limited to one active org (`myLeadsViewer` rejects multiple memberships). Use a fresh run org or isolated case orgs so retained prior fixtures cannot contaminate KPI totals; snapshot and restore per-case organization settings. Create elapsed OPEN appointments for outcome actions, with separate already-completed rows for history checks.
- Seed fresh/contacted/offer/contract-only/archived states; elapsed held/no-show appointments; open/completed/cancelled callbacks; two future next steps; prior-assignee call history; launch-initialized unknown timing; dual-warning records; two inert contact slots and suppression states.
- Set historical prerequisites with fixture-only SQL inside transactions, validating foreign keys, assignment episodes, chronology and queue versions. Prefer existing domain commands where practical. Direct setup SQL is legitimate setup evidence, never proof of a browser transition.
- Map canonical assignment, task, appointment and DNC controls before automating. Inspect `leads/[id]/lead-appointments-section.tsx`, `lead-task-widget.tsx`, `my-leads/_components/existing-detail-actions.tsx`, and task actions.
- J18-01 has a verified implementation: `src/components/appointments/appointment-outcome-row.tsx`. Future appointments expose Appointment actions → Cancel and native window.confirm; register the Playwright dialog handler before clicking, dismiss, and assert the task remains open. Past-due appointments use inline Yes, cancel / Never mind; exercise both dismissal paths on separate open fixtures. Absence in the previous run was not evidence that the product lacked cancellation.
- Inventory the actual appointment/task/calendar/notification/suppression adapters before claiming inertness; existing messaging mocks alone are insufficient. Runtime setup must disable or stub every reachable external writer and assert no outbound provider request escapes. Keep this check local to the campaign.
- Route outbound providers to existing local mocks. Snapshot tasks, appointments, enrollment, eSign and outbound records before/after each action.

Acceptance: each fixture has a machine-checked prerequisite; browser booking/outcome/task completion/reassignment/DNC actions persist on their canonical surfaces and produce the expected My Leads result. Only run-owned data is cleaned up.

## 4. Time boundaries without changing production time

Files: existing `src/lib/my-leads/{time,period}.test.ts`, `scripts/verify-acquisition-time.mjs`; proposed `e2e/my-leads/time-boundaries.spec.ts`.

- Browser timezone contexts: America/Chicago plus a different zone, using identical explicit instants. Verify entry conversion, displayed periods and KPI inclusion at Central midnight.
- Seed elapsed and future data relative to database now for live server-backed warning tests. For threshold refresh, use a short genuine server-time crossing and poll with a bounded timeout; background then foreground the tab to verify recovery.
- Exercise historical DST/working-hours calculations through existing explicit-time TS/SQL interfaces with matching test vectors. Add browser presentation tests for their results, labeled separately from end-to-end server-clock evidence.
- J13-00 Monday and J13-03 DST require an explicit coverage decision before the full run: extract named subassertions from the journey oracle and map each to a real-time browser transition or explicit-time TS/SQL test. Do not silently substitute component proof for the requested browser journey. If an assertion truly requires arbitrary server time, produce a separately reviewed local-only clock design or record the exact scope decision required; this part of the path is not yet implementation-ready.
- For J13-02 use a pending-offer follow-up threshold 10–20 seconds ahead of database time, avoiding business-hour dependence. The client caps its refresh timer at 60 seconds and skips refresh while document.hidden. Use two headed tabs, verify actual visibilityState before crossing, bring the page back, and assert server-backed warning/count refresh within 75 seconds. Synthetic visibility events alone are not proof of a hidden-tab journey.

Acceptance: thresholds just before/at/after; weekend/after-hours and spring/fall DST vectors; deduplicated stale count; hidden-tab refresh; browser and server evidence agree. Do not count a mocked browser Date as server-clock verification.

## 5. Fault injection and independent actor races

Files: proposed `e2e/my-leads/support/faults.ts`, `fault-recovery.spec.ts`, `actor-races.spec.ts`. Inspect `my-leads/actions.ts`, `client.tsx`, and `_components/detail-panel.tsx` to identify actual server-action/read requests.

- Identify one request by action and payload, not all POSTs to /my-leads. Injection is one-shot, scoped to one context and case; always remove handlers in finally.
- Pre-commit failure: abort the selected mutation before forwarding. Assert zero database delta, useful error, retained/recoverable form, successful retry.
- Lost response: forward exactly once with automatic forwarding retries disabled, wait for persisted commit, then withhold/abort delivery. Retry through the still-open unchanged form. Capture a hash of the outgoing idempotency key and payload on both attempts and require equality; assert exactly one domain event. `client.tsx` caches the key by payload hash: reopening or editing is a distinct subcase and must not be called identical retry.
- Refresh failure: allow successful commit response, fail the subsequent relevant read. Verify durable write, recovery and no duplicate mutation.
- Detail failure: fail only one group's read while others remain loaded; retry that group and check cursor uniqueness. Confirm Next server-action transport behavior in a spike before relying on a route interceptor; use a local proxy only if that transport makes precise interception impossible.
- Auth: distinguish JWT expiry from sign-out/refresh revocation; a revoked refresh token can leave an access token valid until expiry. Use a dedicated short-lived synthetic session, measure its expiry against auth-server time, prevent refresh through a scoped test mechanism, and verify `myLeadsViewer` authorization failure with zero database delta. Server actions may return HTTP 200 with an application-level failure, so do not require HTTP 401. Separately test revocation according to actual Supabase semantics. Invalidate the synthetic session and verify the next request is actually unauthorized; clearing client cookies alone is not proof of token revocation. Separately revoke membership while preserving a valid session.
- Two actors: hold each relevant form open while the other actor contracts, declines, transfers or changes permission; stale Save must cause no unauthorized or partial writes. Restore scoped membership/settings after each case.

Acceptance: independent database oracles distinguish no commit, one commit with lost response, and committed write with failed refresh. Recovery must be performed through the browser, with no test-side repair of the mutation.

## 6. Preflight gates, execution and evidence

Dependency order: runtime → fixture factory and datetime helper → time/fault/actor capabilities → representative preflight → fresh 84-case campaign.

Before restarting all cases, require one proven browser submission for offer/contract/decline, an elapsed-appointment outcome, a completed callback, ownership transfer, timezone check, pre-commit failure, lost response, isolated detail retry and actual unauthorized request. Fix preflight defects before spending another full campaign on the same missing capabilities.

Keep the old CSV unchanged. Create a fresh run ledger with every original ID; add subcase IDs for mixed browser/SQL boundary proof. Statuses distinguish NOT RUN, PASS, FAIL (product), SETUP ERROR (harness), and CONTRACT QUESTION. Never describe unexecuted rows as completed. Record SHA, prerequisites, browser actor, actual steps, baseline/poststate, side effects, artifacts, defect and cleanup for every case.

Confirmed product fixes receive focused regression tests and independent Astra review as requested in this task; resolve review findings and rerun affected/neighboring cases. A final full run targets a fixed candidate. Mobile is excluded. This document authorizes no deployment step and changes no application behavior.

## Per-case remediation index

The following is a complete inventory of the 57 previously blocked IDs. Scenario text is preserved from the original CSV. Capability assignments are implementation triage and may be multiple per row; preflight must confirm them.

| Case | Scenario | Primary implementation work |
| --- | --- | --- |
| J03-00 | Log precise offer | 2: datetime; 5: concurrency |
| J03-01 | Concurrent pending offer rejection | 2: datetime; 5: concurrency |
| J03-02 | Required amount method motivation and dates | 2: datetime; 5: concurrency |
| J04-00 | Decline and verify Needs sequence reassignment | 2: datetime; 3: recipient fixtures; 5: races |
| J04-01 | Missing recipient produces no partial transition | 2: datetime; 3: recipient fixtures; 5: races |
| J04-02 | Contract signed before stale decline | 2: datetime; 3: recipient fixtures; 5: races |
| J04-03 | Revised offer only after supported re-entry is established | 2: datetime; 3: recipient fixtures; 5: races |
| J05-00 | Sign then archive | 2: datetime; 3: archive/re-entry |
| J05-02 | Contract without prior offer | 2: datetime; 3: archive/re-entry |
| J06-00 | Book and record held or no-show on separate fixtures | 3: elapsed appointments; 2: chronology |
| J06-01 | Duplicate booking and stale outcome | 3: elapsed appointments; 2: chronology |
| J06-02 | Reschedule separate uncompleted appointment | 3: elapsed appointments; 2: chronology |
| J07-00 | Create snooze then complete callback | 3: callback lifecycle; 2: dates |
| J07-01 | Rapid repeated snooze | 3: callback lifecycle; 2: dates |
| J07-02 | Refresh after each task mutation | 3: callback lifecycle; 2: dates |
| J08-00 | Handoff and supported reassignment back | 3: reassignment/recipient fixtures |
| J09-02 | Disabled-history and non-designated member access | 3: identity fixtures |
| J10-02 | Confirmed commit response loss and identical retry | 5: stale/error recovery |
| J12-02 | Empty recipient and disable-history behavior | 3: disabled-history identity |
| J13-00 | Prioritize Monday overdue work | 4: clock boundaries and warning fixtures |
| J13-01 | Dual warning deduplicates Stale | 4: clock boundaries and warning fixtures |
| J13-02 | Hidden tab across threshold | 4: clock boundaries and warning fixtures |
| J13-03 | DST and after-hours boundaries | 4: clock boundaries and warning fixtures |
| J14-00 | Non-call outreach then qualifying external call | 2: historical attempt entry; 3: call prerequisites |
| J14-01 | Unanswered call with no recording | 2: historical attempt entry; 3: call prerequisites |
| J14-02 | Distinct stage versus first-call evidence | 2: historical attempt entry; 3: call prerequisites |
| J15-00 | Enter prior-day activity and reconcile KPIs | 2: date validation; 4: timezone/KPI boundaries |
| J15-01 | Central midnight in another browser timezone | 2: date validation; 4: timezone/KPI boundaries |
| J15-02 | Correct invalid date without losing valid input | 2: date validation; 4: timezone/KPI boundaries |
| J16-00 | Direct offer then contract without appointment | 2: browser submission; 3: direct-path fixtures |
| J16-01 | Dropbox Sign method sends nothing | 2: browser submission; 3: direct-path fixtures |
| J16-02 | Missing then explicit no motivation | 2: browser submission; 3: direct-path fixtures |
| J16-03 | Contract-only path invents no intermediate events | 2: browser submission; 3: direct-path fixtures |
| J17-01 | Canonical status change during open queue | 3: canonical lifecycle; 5: stale forms |
| J17-02 | Terminal state and stale action regression guard | 3: canonical lifecycle; 5: stale forms |
| J18-00 | Replace cancelled or elapsed next step | 3: appointment/task controls and contract audit; 4: elapsed state |
| J18-01 | Reject cancellation confirmation | 3: appointment/task controls and contract audit; 4: elapsed state |
| J18-02 | Second future item still satisfies next step | 3: appointment/task controls and contract audit; 4: elapsed state |
| J18-03 | Held no-show and completed callback do not auto-qualify | 3: appointment/task controls and contract audit; 4: elapsed state |
| J19-00 | Follow up and resolve overdue offer | 2: decline dates; 5: second actor |
| J19-02 | Resolve from second tab with detail open | 2: decline dates; 5: second actor |
| J20-00 | Transfer ownership while preserving historic credit | 3: transfer/history fixtures; 5: actors |
| J20-01 | Historical-period attribution | 3: transfer/history fixtures; 5: actors |
| J20-02 | Owner sidebar badge versus selected content | 3: transfer/history fixtures; 5: actors |
| J20-03 | New episode ignores previous assignee call | 3: transfer/history fixtures; 5: actors |
| J21-00 | Empty rep receives first assignment | 3: empty rep/launch fixtures |
| J21-01 | Clear no-match search after assignment | 3: empty rep/launch fixtures |
| J21-02 | Launch fixture has honest unknown timing | 3: empty rep/launch fixtures |
| J23-00 | Expire session during filled form and recover | 5: auth/reassignment races |
| J23-01 | Valid session with revoked permission | 5: auth/reassignment races |
| J23-02 | Reassignment while old form remains open | 5: auth/reassignment races |
| J24-00 | Separate pre-commit failure from post-commit refresh failure | 5: scoped transport faults |
| J24-01 | Confirmed commit response loss retry | 5: scoped transport faults |
| J24-02 | Single detail failure leaves other rows usable | 5: scoped transport faults |
| J25-00 | Apply DNC during open workflow | 3: contact slots and canonical suppression |
| J25-02 | Second contact slot follows canonical suppression rules | 3: contact slots and canonical suppression |
| J26-02 | Retry one group and missing optional recording | 5: detail-group fault/retry |

## Manual review disposition — 2026-09-13

Static code review corrected test discovery, cancellation paths, fixture contamination, retry identity, hidden-tab proof, auth semantics and provider-isolation assumptions. The plan is ready to implement runtime/date/fixture and transport feasibility work. Full 57-case remediation readiness remains conditional on (a) transport preflight proving precise interception, (b) the explicit-time coverage decision for J13-00/J13-03, and (c) successful local auth/provider preflight. These are named engineering proof tasks, not grounds to stop all independent work.

## Execution checklist

- [x] Revalidated current isolated checkout: cf60761b; only plan documents were untracked.
- [x] Extended local Playwright discovery to nested campaign specs.
- [x] Restore owned runtime and recover verified synthetic identities; private runtime files recreated.
- [x] Reconcile latest source and record candidate (c600ae7d; later local corrections require a new final candidate).
- [ ] Implement runtime guard, fixtures, datetime and diagnostics.
- [ ] Prove time, transport, auth and provider preflight.
- [ ] Execute fresh 84-case browser campaign.
- [ ] Fix defects, obtain Astra review and verify final candidate.

### Runtime recovery receipt

- Candidate after merging origin/main 3d9c1eec: c600ae7d.
- Owned Colima containers healthy; retained 114 properties and four synthetic identities.
- Recovered private runtime keys from owned gateway; restored passwords only for four metadata-verified synthetic identities.
- Preserved local database backup before applying 20260913100000 and 20260913121000 migrations. Both applied successfully. Full schema parity still needs verification.
- Next development runtime on 127.0.0.1:58700, filtered environment, no private .env files.
- Browser access preflight launched; result pending. No new campaign PASS claimed.

### Browser preflight evidence (2026-09-13)

Passed on c600ae7d with local harness edits:
- Existing owner scope / foreign-org denial: 1 passed, 47.2s cold compile.
- Fresh attempt → readiness → offer → contract → archive: 1 passed, 7.2s; browser datetime entry, amount and archive persistence.
- Fault recovery: 2 passed, 6.9s; aborted-before-forward zero writes, forwarded/lost response one write; identical raw-payload hash on unchanged retry; reload shows Contacted and one attempt.
- Decline: 1 passed, 6.1s; real browser offer/decline, stored declined outcome and configured-owner reassignment.
These are preflight receipts, not a completed 84-case campaign. Fixture setup errors (search locator, contact uniqueness and missing appointment chain ID) were corrected in the harness. No confirmed product defect so far.

Additional preflight results: elapsed Held/No-show with future native-confirm dismissal and elapsed inline dismissal: 2 passed (38.7s). Attempts-page failure/retry retained notes and loaded 25 distinct timestamps: 1 passed (3.1s). Expired membership caused zero writes and cleared session; restored membership plus reauthentication allowed one new attempt: 1 passed (4.8s). Callback snooze/completion persisted on reload, retained one task and zero offers: 1 passed (7.7s).

Fresh WORKFLOW-TEST-CASES-20260913.csv created with all 84 cases NOT RUN; preflight is deliberately not backfilled as full campaign coverage. Independent Astra harness review started in this task.

- Confirmed-save/failed-queue-refresh preflight passed (1 test, 10.6s): forwarded one real browser mutation, checked persisted attempt before delivering success, aborted the following queue read, then reloaded and verified Contacted with one attempt and exactly one mutation request.
- Shared freshLead fixture factory now appends a secret-free ID/actor/candidate/retention manifest. This improves auditability but does not yet provide clean aggregate KPI isolation.

### Production build stabilization

The development runtime is stopped. Repeated appointment preflight produced intermittent navigation/menu detachment (5/6 repeated appointment tests passed); production-mode reproduction remains required. Production build uncovered unsupported named exports in four page modules and five API route modules. Page constants are now local; route implementations moved to adjacent handlers.ts while HTTP methods and literal maxDuration remain exported by route.ts. No application behavior is intentionally changed. Independent Astra review approved the four page diffs; route extraction review and production build are in progress. These failures are build evidence, not My Leads campaign passes.
