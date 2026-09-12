# Isolated local acceptance runtime

Status: local candidate verified; hosted CI, live provider parity, and rollout remain pending.

- Owner: this isolated My Leads task. No Sandra Orchestrator or shared controller is used.
- Colima profile: `sandra-my-leads-20260911`, created for this task, 2 CPUs / 4 GiB memory / 24 GiB requested disk. Started without changing the default Docker context.
- Docker host: `/Users/jarradhenry/.colima/sandra-my-leads-20260911/docker.sock`. Every Docker/Supabase command must explicitly select it.
- Supabase work directory: `/tmp/sandra-my-leads-acceptance-20260911`.
- Ports: API 58321, PostgreSQL 58322, auxiliary local services in the 5832x range.
- Start excludes Studio, image proxy, Realtime, edge runtime, analytics/vector, and pooler. Auth/REST/storage/database are local only.
- No hosted project link, production credentials, or provider keys. Do not import private environment files. No remote migration or account provisioning has occurred.
- Startup output may contain local credentials and stays outside the repository with mode 0600. Do not copy it into reports.
- Baseline has 216 committed SQL migrations. The reproducible full-schema verifier replayed these plus all 13 feature migrations successfully. The existing private PG component scripts are narrower evidence.
- Account budget: at most four distinct acceptance principals across the campaign. Two fixed surrogate identities were used in disposable component PG scripts; reuse these for local authenticated acceptance and add one cross-org identity if needed. Do not invoke broad E2E/global fixture reset helpers.
- Before browser acceptance: freeze candidate, complete required independent review, verify runtime isolation and source migration compatibility, define bounded fixture IDs and expected side effects.
- Cleanup: stop this Supabase stack using its explicit workdir and Docker host, then stop the owned Colima profile. Preserve other profiles/containers/worktrees. Remove temporary credentials and artifacts after secret-safe evidence is retained.

## Preparation evidence

- Dedicated Colima/Supabase runtime is healthy. All 216 committed baseline SQL migrations replayed successfully, followed by all 13 My Leads migrations through launch. Later function fixes are applied explicitly; no hosted project is linked.
- Actual GoTrue principals: exactly four, at the campaign cap. Organization B needs its own permanent owner under the existing Hugo guard, so the fourth principal supports the cross-organization member test. Principal roles are owner A, rep A, owner B, member B. Fixed IDs reuse the owner/rep IDs from the disposable SQL fixtures. Credentials remain in mode-0600 temporary files, never this repository.
- Nine synthetic property fixtures, four memberships, two fixture organizations. The local primary fixtures use Sandra’s existing seeded organization ID, as required by the native middleware; the other organization tests rejection.
- Authenticated REST RPC checks pass for owner/rep queue equality and foreign-member denial. Full-schema attempt logging, readiness, offer logging, and contract-without-offer pass.
- Initial direct contract from Not contacted exposed a missing-queue handling bug. The worker fixed it; full-schema authenticated retry now passes and returns an idempotent replay.
- A launch review found that the first implementation excluded genuine pre-feature leads with no prior episode. This was corrected and the fresh full-schema verifier passed preview, apply, replay, and no-fictitious-activity checks for the genuine legacy lead.
- The first browser run was denied by the existing fixed-organization middleware because fixtures used a different primary organization ID. The fixture generator now matches the native ID locally; a fresh replay and browser rerun are pending. No production authorization was changed. These API/schema proofs are not UI acceptance or release evidence.

## Reproducible verifier

`scripts/verify-my-leads-full-schema.mjs --reset-owned-local` asserts the owned stack and four fixed identities before resetting only this local database. It replays the committed baseline and current feature SQL, records hashes in a secret-free temporary receipt, exercises legacy initialization, and prepares browser workflow fixtures. The app runs on loopback port 58700 with a filtered environment containing only local Supabase keys and no provider credentials.

## Browser and integration checkpoint

- Native fixed-organization fixture replay passed after adding the baseline-required phone line type and reusing the seeded Sandra organization locally. Four fixed principals remain the total.
- Full unit suite: 343 files / 3,776 tests passed.
- Full RTL suite: 116 files passed, one unchanged campaign form test timed out at five seconds (1,263 passed / one timeout). Its focused file rerun passed all seven tests. This is not a claim that the original full invocation passed.
- Browser member self-scope, owner selected-rep inspection, foreign owner/member denial, and narrow-width overflow checks passed.
- Focused browser runs exercised attempt → Contacted, required motivation, offer logging, contract recording, and archive. Test locator corrections were necessary; a final fresh-cohort sequential run remains required.
- Notes and deliberate appointment booking passed in browser. Handoff found a real missing-recipient defect in the member roster response; correction is in progress.
- Browser found duplicate headings and a mutation revalidation effect that unmounted newly opened details. Both source fixes are applied; the latter has an independently authored regression test pending.
- Root corrected appointment detail attribution to use immutable booking-time accountability while retaining the current assignee for lifecycle authorization. The private PG evidence verifier passed the new reassignment assertion.
- Workflow review found missing finite/nonfuture event-time validation. The worker applied offer/decline checks and private direct-RPC regressions passed. Current full local schema must be replayed before final acceptance because these source fixes postdate its last replay.
- No production data, provider calls, commits, pushes, PRs, or deployment occurred at this checkpoint.

## Fresh sequential browser acceptance

The final fresh fixture replay passed all 216 baseline and 13 feature migrations; all 13 source hashes matched its receipt immediately before acceptance. `npx playwright test --config=playwright.my-leads-local.config.ts` then passed all four tests in 9.5 seconds with zero retries:

1. Member self-scope and desktop/narrow layout.
2. Owner rep selection plus foreign owner/member denial.
3. Attempt → Contacted → required motivation → offer with follow-up → contract → deliberate archive.
4. Attempt → note → deliberate appointment booking → configured owner handoff.

The workflow test now executes every step sequentially from a fresh fixture; it does not skip stages based on existing state. Root inspected desktop and narrow screenshots of synthetic fixture data. These images stay in the owned temporary acceptance directory, alongside a secret-free SQL hash receipt; they contain no auth fields. Auth traces/storage-state artifacts remain disabled. The member handoff recipient and detail refresh defects are fixed and covered by this passing run.

The app was stopped after browser acceptance to build the current candidate without racing the development output directory. Production build and signed local HTTP receiver proof are still pending at this checkpoint. This local campaign does not establish live provider deployment parity or authorize production cohort initialization.

## Final source verification checkpoint

- Current production build passed with a filtered environment pointing only to the local Supabase runtime; no provider credentials were loaded.
- `verify-my-leads-local-transport.mjs` passed against that production server: invalid signature, operator/setup evidence, and unbound context rejected; valid seller evidence and duplicate delivery yield one attempt and one original-assignee clock. Its temporary webhook consumer was deleted. No real provider was contacted.
- `verify-my-leads-local-outcomes.mjs` passed: four principals, exactly one deliberately booked appointment, zero sequence enrollments, and configured-owner Needs sequence handoff.
- Final source suites with bounded four-worker concurrency passed: 344 unit files / 3,778 tests; 118 RTL files / 1,265 tests. This successful full rerun resolves the earlier resource-sensitive campaign timeout without rewriting that earlier result.
- Read-only remote checks confirmed both main baselines remain unchanged (Sandra `8c7053e7`, Jitter `2c00aafa`).
- Additional keyboard, report-period persistence, and warning-clearance browser assertions are being added; no product source change is required by them at this checkpoint.

## Expanded production-build browser result

After a further fresh 216+13 replay, all **seven** serial browser tests passed against `next start` in **12.4 seconds**, zero retries. Added checks passed: owner designation off/on with restoration, keyboard Enter/Escape dialog cancellation, Under Contract visibility across reporting-period changes, missing-next-step warning visibility and clearance after explicit booking. The local outcomes and signed HTTP receiver scripts both passed again afterward. No product source change followed the successful production build.

The Jitter producer candidate is committed locally as `c41f2e0`; neither repository has been pushed. Sandra's native commit verification is the remaining local gate before its candidate commit. Hosted CI provisions job-scoped identities, so publishing the PR requires resolving the approved four-account campaign limit rather than silently provisioning extra accounts.

## Native zoom

`verify-my-leads-local-zoom.mjs` passed at actual Chromium tab zoom 2.0 via a temporary extension's `chrome.tabs.setZoom`, not CSS scaling or viewport emulation. No horizontal page overflow; the attempt dialog opens and cancels. Root inspected the viewport screenshot. The extension/profile are removed in `finally`; no user browser profile is touched. The existing full Chromium installation was incomplete and Playwright's replacement extraction stalled, so the task-owned official browser archive was extracted with the system extractor into a separate temporary directory. The normal headless acceptance browser remained unchanged.

## Candidate commit and native gate

Sandra implementation commit `4328b355` and Jitter producer commit `c41f2e0` are local only. The generated hook launcher was absent after dependency installation without lifecycle scripts, so root explicitly ran the tracked `.husky/pre-commit` with the task-owned local rehearsal database. It passed all 12 atomic-migration tests, the eSign local database rehearsal, typecheck, 3,778 unit tests, and 1,265 RTL tests. No hook requirement was waived.

The local calendar worker reported a missing OAuth encryption key, as expected in this provider-free runtime. Database appointment booking and its ledger were verified; Google/calendar-provider synchronization was not. This is retained as an integration limitation, not reported as external calendar success.

## Cleanup and continuation

The owned Next server, Supabase stack, and Colima profile are stopped. Other profiles and worktrees were preserved. Temporary runtime keys, fixture passwords, credential-bearing startup/reset logs, and the task-owned replacement browser download were removed. Secret-free schema hashes, screenshots, and `identity-manifest.json` remain in the owned temporary directory; the durable schema receipt is in `plan/evidence/full-schema-replay.json`. Restarting local acceptance requires reconstructing only these same four fixture identities and local runtime credentials; do not provision additional principals or invoke shared global setup. The local volume remains available.

PR publication is awaiting a user decision: the approved plan caps the campaign at four accounts, all used locally, while `.github/workflows/e2e.yml` invokes `e2e-identity-lifecycle.ts emit/preflight` to create two job-scoped hosted identities. No push or PR has been performed to bypass that limit. Source implementation/review/local verification is complete; hosted CI, deployment/migration verification, provider parity, and reviewed Maria initialization remain open.

## CI discovery follow-up

The broad CI and production Playwright configurations initially discovered `my-leads.local.spec.ts`, which requires the dedicated loopback fixtures. Both now explicitly exclude that one spec; its dedicated configuration remains unchanged. Discovery-only checks selected zero local-fixture tests in the broad configurations (expected `No tests found`, exit 1) and all seven in the dedicated configuration. These are test-selection assertions, not additional browser executions. Placeholder environment values were used only to load the CI configuration; no users, browser, server, global setup, or hosted operations ran.

Focused ESLint/typecheck passed. The tracked native pre-commit verification also passed again using an automatically cleaned private Unix-socket PostgreSQL cluster: 12 atomic-migration tests, eSign rehearsal, 3,778 unit tests, and 1,265 RTL tests. Application source and the dedicated browser journeys did not change. SOURCE-MANIFEST.json now includes both broad configuration files. PR publication still awaits the account-limit decision; the automatic goal continuation is not approval to create additional accounts.

## Deployment-readiness authorization amendment

The user now authorizes PR publication and required temporary CI identities (including rerun replacements), with cleanup. The previous account-limit blocker is resolved. Deployment, previews, merging, shared migrations, feature enablement, real cohort writes and real contacts are prohibited. DEPLOYMENT-READINESS.md tracks this narrower completion scope and the new manual review. Earlier checkpoint statuses above are historical.

## Deployment-readiness review verification

- Fresh private PostgreSQL time, call-evidence, workflow/launch and Jitter context rehearsals passed. The call-evidence verifier now independently reduces raw stored facts in JavaScript and matches owner/self RPC KPIs, including a positive, period-independent stale count.
- Replayed the owned local fixture stack: 216 baseline + 13 feature migrations passed again, recreating the same four principal IDs only.
- After the confirmed custom-range/badge/error-association fixes, the production build passed. The expanded local browser lane passed all **9 tests in 14.7 seconds, zero retries**. New coverage: equal owner/self KPI tiles; complete custom range entry; normal pre/post offer warning states and red borders. Existing workflows and narrow layout still pass.
- Post-browser SQL again confirms four principals, one deliberate appointment, zero enrollments and the configured-owner handoff.
- Initial Sandra GitHub Verify passed; final candidate checks remain to run after review fixes are pushed. Jitter's initial full run passed 2,681 tests but failed one unchanged browser-audio cleanup-timing assertion; the exact focused test passed locally (1 passed/123 skipped), and the failed CI job was rerun without changing product code.

Final launch-fix replay passed 216+13 migrations, then all 9 browser journeys passed again in 14.6 seconds with zero retries. Post-browser outcomes again passed. Native verification after UI fixes passed 3,778 unit and 1,268 RTL tests; the launch-only follow-up passed its focused PG regression and full replay. Final CI evidence is attached to the PRs after publication.
