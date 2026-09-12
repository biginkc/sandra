# Canary maintenance: reviewed repairs and remaining retirement gates

Base: `4bdc6e127c50fe551e666f526a4c065fc9158c1b`, freshly fetched main. Branch: `codex/canary-repair-20260912`. This is separate from the browser reliability candidate `f89e7a3f`.

## Preserved checks and corrected behavior

- The lead-management browser canary selects the current self label (`name/email (you)`) instead of the obsolete `Me`. The database must still persist the exact authenticated user ID, status, and motivation. After reload the test opens the lazy-loaded roster and checks the same selected label on the trigger. This is a selector repair, not a completed live browser execution certificate.
- The Sendillo smoke now replays an identical payload, including `receivedAt`, and checks the persisted body.
- STOP side-effect database errors propagate immediately rather than becoming misleading condition timeouts.
- CLI PASS reporting occurs only after cleanup succeeds. The import guard permits mocked tests without executing the script against production.

## Reproduction

Four mocked-I/O regressions fail against the original script, with only an import seam added for testing:

1. Replay timestamp differs after the mocked clock advances.
2. Cleanup fails after a PASS has already been printed.
3. Incorrect persisted message content is accepted.
4. A STOP consent query error becomes a generic condition-not-met error.

All four pass with the changes. No network, provider, production credential, or shared database is used by these tests. The test file is included in the existing native unit suite. Focused ESLint and TypeScript pass.

## Independent source review

Independent manual reviewer `/root/navigation_manual_review`, canary-maintenance round 1: PASS, no blocking corrections. The reviewer inherited its original root settings; the tool did not expose actual model settings. It performed no tests, edits, or database operations.

| File | SHA256 |
| --- | --- |
| e2e/prod-canary/lead-management.spec.ts | 00c9a010d5f3b3b7897af8700cdf1e39d5035cee3ec3e36bc7fdcc44b7b2d17b |
| scripts/smoke-sendillo-webhook-prod.ts | 6f3dcbfc3504d163a539a683a8e21c84eed9546056dc9d6f3c14f68a901d5016 |
| src/lib/prod-canary/sendillo-smoke.test.ts | faea77a0166ba50126588054d5aa1a5fa5efc184910126450d407a412816a2de |
| vercel.json | 33146daf976320d56ac00f4b25eeafcd062aec3ed0ed4c076f3bbcc78cc14660 |

Tracked binary diff SHA256: `20885971fdf6e345c4d87e68543476353f10f17a89898e02ebfbeb17885c8769`.

## Still incomplete

This script is not yet a verified replacement for an old scheduled canary. The second source revision adds an allowlisted owned number, unused-phone/suppression preflight, explicit org-membership verification, mobile phone type, durable STOP-suppression assertions, and suppression cleanup constrained to this run. The guards have mocked negative-case verification. The regular inbound path also passed against the private local database and real route; production/provider execution is not certified. Exclusive admission is still necessary because read-before-write preflight is not a global lock. Other lifecycle side effects still need runtime inventory and verification. The four old scripts and their schedules remain intact, and Sequence PR 517 remains owned by its existing session. Production/provider execution is outside this session's authorization.

The branch has an explicit Vercel preview exclusion before publication. No PR, merge, deployment, migration to a hosted database, or real message/call has occurred. Broader Messages/My Leads coverage remains deferred for Jarrad's later consultation.

Separate independent `/root/navigation_code_approval`, explicitly gpt-6-astra / medium, returned APPROVE for this source candidate after considering manual round 1 PASS. It independently verified all four hashes, performed no tests or writes, and retained the live-readiness limitations above. Full scoped diff SHA256: `9288957ef20e1a240c1d9234de98d8731a9ee7c32bfa934aa9402aca4587c035`; sorted scoped manifest SHA256: `bd21b0596bc0c07cb5a5aa1ae326c1f5548607173d723c38227ea56be59c2935`.

## Native verification evidence

The required `npm run verify` passed its 12 atomic migration tests, private-loopback eSign rehearsal, TypeScript, and all 3,793 unit tests in 345 files. Its component phase had 1,271 passes and one timeout: the unchanged Coach test `keeps the authorized file number visible while the rep advances through the script` exceeded its five-second limit. That exact test passed in isolation in 478 ms. This is consistent with execution contention but does not by itself prove the cause. No timeout, assertion, or Coach source was changed in that first invocation. The final revision limits RTL workers to two and synchronizes template clicks on the initial selected-option focus. The complete component run with two workers also failed: Coach passed, but the unchanged template test for clearing All categories did not call router.replace. Thus reducing parallelism did not establish a reliable full-suite gate. Both failed invocations are retained. These are retained historical failures. The final aggregate invocation subsequently passed, as recorded below.

Installed Base UI SelectItem only commits non-touch clicks when the option is highlighted. The template test waits for DOM mounting and immediately clicks; it does not synchronize on highlighting. Focused execution subsequently reproduced the race: selected-option initialization could overwrite the intended interaction. The final test waits for the initially selected option to receive focus before the ordinary mouse click; the original URL assertions remain.

## Second source revision

The CLI now requires the same `PROD_CANARY_SMS_TO` / `PROD_CANARY_SMS_ALLOWLIST` convention as the existing browser suite. It refuses a number already present in any contact phone slot or phone suppression, refuses the sender number, and validates an explicitly selected org against the canary user's memberships. Only after those checks does it create a contact with `phone_1_type: mobile`.

STOP success requires durable suppression with the run's contact, provider and external webhook ID, in addition to existing consent/contact/enrollment checks. Cleanup discovers persisted message IDs even after an earlier assertion failure, deletes only suppression matching org/channel/phone/contact/provider/external ID, and retains the contact if remaining suppression attribution cannot be cleared and verified.

Eleven mocked-I/O cases pass, including missing allowlist, existing contact/suppression refusal before any writes, missing durable STOP suppression, and a cleanup no-op that must fail and preserve the contact. Focused ESLint and TypeScript pass. Round 1 hashes and approval remain historical and do not approve the final source. Round 3 manual review covers the final source; separate final CODE approval is pending.

### Completion checklist

- [x] Audit old scheduled implementations and identify unique coverage.
- [x] Repair obsolete self-selector without removing persisted-user assertion.
- [x] Reproduce and repair Sendillo result/replay/error-reporting failures.
- [x] Add guarded typed fixtures and constrained suppression cleanup with mocked negative cases.
- [x] Complete independent manual review of revision 3; separate final CODE approval remains pending.
- [x] Complete the native aggregate gate; earlier component failures and their corrections remain recorded.
- [ ] Verify retained canaries against an admitted target and inventory all remaining side effects.
- [ ] Retire old scripts only with validated replacement coverage and updated callers.
- [ ] Consult Jarrad on exhaustive Messages/My Leads coverage at the deferred coverage stage.


## Final verification (2026-09-12)

`npm run verify` completed with exit 0: 12 atomic migration tests, private-loopback eSign rehearsal, TypeScript, 3,801 unit tests in 345 files, and 1,272 component tests in 118 files. Evidence: `/tmp/sandra-canary-native-final-v3.log` on the task host. This is one passing aggregate invocation; it is not a claim of statistical flake elimination. Earlier failed invocations are retained in the task evidence.

The real Select browser contract passed in Chromium (one test). It compiles the application's Select component and verifies both All and Probate mouse selection. The focused template and Coach component group passed all 35 tests. No assertion deadlines or retries were increased. Two RTL workers reduce simultaneous DOM work; the template tests also explicitly await initialization.

The existing Sendillo route integration suite passed all 20 tests against a private loopback Supabase stack. The additional local regular-inbound diagnostic passed through the actual route and SQL database, removed its own rows, and preserved an unrelated synthetic contact, property, and suppression. Exact-run account cleanup verified zero remaining Auth users. These runs used synthetic data and did not call a real provider.

The twelve mocked smoke-script cases include the four original reproductions plus fixture preflight, suppression, and cleanup failure guards. These are in the native unit total above. The local diagnostic files are explicitly outside ordinary unit/integration/hosted gates and are not verified replacement canaries.

## STOP is not ready for production mutation

The real local STOP diagnostic exposed two different problems. First, an opt-out event timestamp was 63 ms earlier than the fixture's opt-in timestamp. Selecting the latest timestamp therefore missed a successfully applied opt-out. The script now selects the exact `opt_out` event by webhook external ID and retains contact, enrollment, and durable suppression assertions.

Second, STOP appends to the immutable `lead_events` ledger. Migration `20260825170000_lead_events_ledger.sql` grants service-role SELECT/INSERT only; its property foreign key prevents deleting the parent fixture. The positive STOP diagnostic still fails cleanup with `lead_events_property_org_fkey`. This is recorded as a real unresolved production-cleanup limitation, not converted into a passing test or bypassed with a migration.

The production CLI therefore refuses STOP before mutations. A diagnostic override requires explicit opt-in and the actual SDK client's exact loopback URL. The four old scheduled implementations and schedules remain unchanged pending the user's decision about moving mutation checks into disposable tests and verified preservation of useful coverage.

## Local diagnostic lifecycle qualification

`vitest.canary-local.config.ts` requires the exact loopback API and SQL ports. The diagnostic uses a task-owned empty Auth baseline and requires an external lifecycle runner; **do not invoke it directly against an existing developer stack**. Its `afterAll` is not account cleanup. The task runner at `/tmp/sandra-run-local-canary-proof.cjs` performed preflight and, in `finally`, verified exact run ownership, reset the disposable fixtures under both historical advisory locks, restored the initially empty membership baseline, invoked the unchanged exact-run cleanup CLI, and verified zero Auth users. That task-local runner is not a portable supported repository command.

The fetch guard rejects nonlocal initial fetch URLs and counts rejected attempts, including caught errors. It does not claim comprehensive network isolation: automatic redirects are not revalidated and other networking APIs are not intercepted. Workflow dispatch is forbidden; actual AI dispatch in this fixture must return a skipped result. The application/provider production readiness remains unverified.

## Final manual review

Independent reviewer `/root/navigation_manual_review` returned round 3 PASS for source with no blocking code corrections. It performed no tests or mutations. The external-runner dependency, initial-URL-only guard, and failing STOP cleanup were explicitly retained as limitations. This receipt corrects the stale historical statements identified by that review. A separate current-candidate Astra/medium CODE approval is still required before advancement.
