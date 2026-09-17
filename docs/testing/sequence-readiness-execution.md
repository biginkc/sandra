# Sequence readiness execution evidence

Goal: implement and verify the Opus 5-approved revision 3 plan through production deployment readiness. Jarrad explicitly authorized implementation/fixes/tests/review/PR preparation. No production merge/deployment, migration application, real SMS, or recurring send is authorized by this scope. Implementing agents use gpt-5.6-luna at xhigh, as explicitly requested.

## Candidate and dependencies

- Worktree: `tmp/sequence-readiness-20260917`; branch `codex/sequence-readiness-20260917`.
- Foundation: PR #530, exact reviewed head `21b91d1a3dab670008e926f07d6acd5c661c817a`. Independent source review approved reuse. Its prior hosted disposable run passed 108 tests; the separate failing hosted E2E run did not execute this runner. This does not excuse browser acceptance on our candidate.
- Merged current main `f3647e0c03faea72783e3fc52b384de92aac8477`, resolving only Vercel branch deployment-disable entries; merge commit `c7b409a8`. This candidate branch has preview deployment disabled.
- Reviewed PR #516 bookkeeping diff reused in candidate; independent source review approved its narrow error reporting. Its silent-stall/recovery limitations are being addressed separately. It is not treated as a recovery solution.
- No remote push, PR creation, merge into another owner's branch, or deployment has occurred during this execution stage.

## Verified baseline

- Node 24.21.0; Supabase CLI 2.116.0.
- Dedicated run-owned Colima profile `sequence-readiness-20260917`; Docker server 29.5.2. Commands target its explicit Unix socket. The previously selected global Docker context was restored after profile startup changed it.
- Runner cancellation contracts: 2 tests passed for interruption during startup and tests.
- Focused sequence baseline with reviewed #516 diff: 76 tests in 7 files passed.
- Initial fresh disposable stack successfully applied all current-main migrations using PostgreSQL image 17.6.1.165.
- First integration attempt: 15 queue tests passed; four suites failed at module import because reused dependencies lacked current main's Sentry package. This is a dependency/configuration failure, not a sequence acceptance result.
- Teardown completed; direct Docker inspection showed zero containers and zero volumes in the dedicated runtime after that run.
- Installed the exact current package lock into an isolated temporary dependency directory and repointed the worktree's node_modules symlink. No package manifests/lockfiles changed. Current source tests and typechecks must be rerun with these complete dependencies.

## Work in progress — not acceptance evidence

- Runtime: durable attempt classification, explicit safe retry with preserved history, guarded final authorization, stale-claim visibility, state-aware advancement, recovery UI and migration.
- Tests: real disposable-DB lifecycle, claim concurrency, pause/cancel races, recovery and ambiguous-provider outcomes. Known-failure assertions may not delete claims or infer non-delivery from missing external IDs.
- Harness: real database/source manifest, isolated provider network denial and broader sequence suite.
- Review findings are being fixed before readiness: unknown legacy attempt defaults, SECURITY DEFINER tenant boundaries, retry claim ownership, suppression parity, error/row-count handling, repairable missing-template/sender claims.

## Still required

Finish and review the implementation; execute all required regression/integration and isolated browser cases; prove targeted mutations are detected with green unmodified controls; run required repository checks; review migration compatibility/rollout; prepare a dependency-correct PR and independently review its tested SHA. Live-provider phases remain disabled. No overall readiness or production-health claim has been made.

## Second disposable attempt — environment failure

The revised runner applied all migrations, including recovery migration hash `8fde68c2f0d830ed7fa4fa833d2ebfa89dc8a190ca61fb57b0680ddea6a41e01`, on PostgreSQL 17.6/read committed. The manifest verified the partial active enrollment/step unique index. 65 tests passed before host disk exhaustion caused PostgreSQL fsync I/O errors and Vitest ENOSPC import failures; native sequence suites did not execute. This is FIXTURE_CONFIG_FAIL, not product acceptance.

Supabase stop returned success but left owned containers/volumes after filesystem corruption. Explicit volume removal and guest fstrim also failed with I/O errors. The task-owned Colima profile and its disk were deleted, recovering approximately 9 GiB and destroying all of that disposable test data. Other profiles and worktrees were preserved. A reduced stack and explicit teardown verification are required before retry.

Read-only review also found ambiguous PL/pgSQL output-variable references and a dangerous classification of post-provider persistence errors as no-attempt. Luna is fixing these with regression tests before the next database run.

## Broader regression snapshot

Component suite: 1,511 tests passed in 146 files. Unit suite during ongoing runtime edits: 4,602 passed, three failed in tick mocks missing the new filtered update method, three skipped; 405 files passed, one failed, one skipped. Worker is repairing those mock contracts and focused regressions. This is not final candidate evidence; rerun after source freeze. Logs are `/tmp/sandra-sequence-rtl-20260917.log` and `/tmp/sandra-sequence-unit-20260917.log`.

Unit rerun after recovery fixes: 4,607 passed, three skipped, zero failed across 406 passing files and one skipped file. Runtime-focused tests: 52 passed. TypeScript passed as reported by runtime and acceptance workers. Database acceptance suite is frozen for the next run, including 20 synchronized two-client trials and authorization-boundary trace cases.

## Third disposable run — behavioral failures exposed

Reduced stack applied migration hash `1f2b21b74b76fa985fcfab997410c254d43c811b8d885ab1e56873806d09b8b7` on PostgreSQL17.6/read committed. Result:139 passed, three failed, nine files passed and one failed. Native three-step lifecycle,20 synchronized two-client claim trials, pre-authorization stops, authorized in-flight stop boundaries, ambiguous receipt protection, original enrollment/tick simulations, queue regressions, inbound adapter regressions, and egress guard passed. Two explicit recovery calls returned failed; one accepted-crash test incorrectly expected a null message link despite the atomic authorization intent linking the pending message. These remain unresolved until repaired and rerun.

Teardown succeeded; independent Docker checks verified zero containers and zero volumes. Owned VM image cache retained for subsequent runs, approximately3GiB host free. Guest fstrim reclaimed approximately1GiB of unused blocks. Log: `/tmp/sandra-sequence-disposable-20260917-run3.log`.

Opus preliminary source review session `f7b3ec94-5722-4541-806e-570e4e6a2942` returned CHANGES REQUIRED; see sequence-opus-source-review-1.md. Several recommendations are disputed because blanket legacy-claim retirement/default-not_attempted could permit duplicates; no such unsafe recommendation has been implemented. A separate Opus disposition review is pending. Independent migration review also found the dialer resume bypass, explicit anon ACL omissions and historical step-deletion compatibility changes; these are assigned for repair.

Provider evidence: public [Sendillo OpenAPI](https://www.sendillo.com/api/v1/openapi), retrieved September17,2026, documents POST /api/v1/messages200 as accepted/queued and400 as invalid body or sender not on account. It does not establish a blanket definitive-rejection contract for all4xx. The adapter classification is being narrowed to documented400; other errors retain ambiguity. Response-body reads must remain within the request deadline. No authenticated provider API or send was called.

Opus disposition session `cef4286b-b245-405e-990c-51279deceb2c` withdrew blanket legacy retirement, default-not_attempted, broad index deletion, archive-stop changes and arbitrary retry/cooldown policies. It accepted unknown+active legacy fences, explicit cancellation as the safe actionable exit, and mandatory quiescing/inventory at rollout. Known-accepted advancement on resume remains an optional deferred extension. No final source or deployment approval was granted. See sequence-opus-review-disposition.md.

## Fourth disposable run — acceptance still blocked

Result: 148 passed and eight failed across 156 tests; nine files passed and three failed. The browser lane did not run because integration acceptance failed first. Failures cover recovery clock fixtures, a call-pause barrier, foreign-organization membership setup, a concurrent-stop boundary, and 101-enrollment fairness. Each needs a verified correction; no expected-failure waiver applies. Log: `/tmp/sandra-sequence-disposable-20260917-run4.log`. Teardown succeeded and independent Docker inspection verified zero containers and zero volumes in the dedicated runtime.

Broad regression snapshot before the next corrections: 4,612 unit tests passed (three skipped), and 1,511 component tests passed. The component test correction waits for the calculator result to render rather than merely waiting for its search callback. These results do not supersede the failing database contracts.

Opus source-review request 2 (session `dc78ed0d-8d00-4aa4-837d-2f9f10457766`, verified `claude-opus-5`) returned only a proposed hash-inspection command, not a review verdict. It provides no approval. A clarified offline review request supplies the same snapshot and explicitly requests substantive review without unavailable tools.

Opus substantive source review 2 (session `064458e9-ea32-4677-8876-1eaa5057527c`, verified `claude-opus-5`) returned CHANGES REQUIRED. It confirms the core send fence and safe claim-retirement invariant, while requiring a single-row stale-reconciliation result, suppression-first tied consent timestamps, atomic claim-linked cancellation audit, and a stale header correction. `consent_events.occurred_at` is NOT NULL in migration 007, so the suggested NULL risk is unreachable in this schema; the tie-break defect remains. Runtime fixes and regression tests are assigned; final source review remains pending.

Browser-only attempt 1 failed at Next/Turbopack startup because the exact-dependency cache is linked outside the worktree root. No browser behavior passed. The isolated config is switching to the documented webpack development mode. Cleanup was independently verified empty.

Full repository lint reported 387 errors and 154 warnings. Changed-file inspection identified two new CJS-preload import errors (being fixed with narrowly documented exemptions); the remaining error locations are unchanged repository files. This is not a clean repository-wide lint result.

Browser-only attempt 2 reached the actual app: four passed and two failed. The non-admin authoring boundary, cross-org visibility, browser external HTTP denial and server external HTTP denial passed. Both create/edit and SMS/thread flows timed out at a disabled Create button with an empty Name field after the helper had filled it; hydration/navigation timing is under investigation. No persistence or delivery acceptance is claimed for those flows. Log: `/tmp/sandra-sequence-browser-only-20260917-run2.log`. All owned containers and volumes were removed and independently verified absent.

The backlog defect is confirmed and repaired locally with stable `(next_run_at,id)` keyset ordering and one bounded lookahead page when all 100 initial rows retain claims. Claims are preserved and budget checks remain; larger retained backlogs may still wait for stale reconciliation. Focused handler tests passed (3/3); actual database evidence remains pending.

Post-review fixes B1–B4 are implemented with security regressions: single-row stale reconciliation, opt-out-first consent ties, atomic tenant-checked claim-linked cancellation audit, actor attribution, and corrected claim-retirement documentation. Focused runtime/action tests: 46 passed; TypeScript and changed-file lint passed. Opus source review 3 is pending on pinned source hashes.

Required native PostgreSQL rehearsals passed: eSign atomic packet unit checks, complete eSign essentials rehearsal, and calculator migration rehearsal. An explicitly owned temporary PostgreSQL17 instance at loopback is used for these checks; no shared or hosted database is accessed.

Local headroom fell below the runner's 3GiB floor after browser checks. Owned .next cache was removed, Docker containers/volumes verified empty, guest blocks trimmed, and the task-owned Colima VM stopped. Approximately2.3GiB remains. The disk guard is unchanged. The approved fresh-GitHub-runner alternative is being prepared with browser acceptance and existing Verify checks on the deployment-disabled candidate branch.

Opus source review 3 — SOURCE REVIEW APPROVED, session `0a90fcc3-520c-4499-bfa1-2a0bd908bf64`, verified `claude-opus-5`. Runtime hashes match the supplied reviewed snapshot; only STOP test parameterization changed afterward. Review approves the corrected B1–B4 runtime and bounded scheduler mitigation, conditional on final real-database/browser/mutation evidence. It is not deployment or live-send authorization. See sequence-opus-source-review-3.md. Independent migration delta review also found no concrete source blocker, retaining actual authenticated RPC execution and rollback tests as evidence gates.

Independent mutation-harness review found executable-test counting, Docker project ownership, intended-assertion detection, pre-cleanup PASS output, and JSON scrubbing defects. They are assigned for correction before mutation execution. No mutation proof is claimed.

The task-owned, stopped Colima profile `sequence-readiness-20260917` and its disposable image disk were deleted after independent zero-container/zero-volume checks. Logs and browser evidence remain preserved. Host headroom recovered from133MiB to5.9GiB; the global Docker context remains `colima-sandra-query-evidence-20260914`. Remaining full database/browser checks will use fresh GitHub runners. No other profile was changed.
Candidate `f6823c99ecbfc6b7aa21dc9188e94c5316721a90` passed the actual Husky pre-commit verification: required PostgreSQL rehearsals, TypeScript, 4,614 unit tests (three skipped), and 1,511 component tests. The generated Husky files were initially absent in the linked-dependency worktree; `npm run prepare` restored them and an amended commit ran the complete hook successfully. Log: `/tmp/sandra-sequence-commit-verify-20260917.log`. The reviewed #516 dependency is being merged to record ancestry while preserving the approved candidate source.

Fresh GitHub runner run35207816051 at `14bb4d13088f718870cb23aafa8d70b1c1de5ea7`: 214 database integration tests passed and17 failed; browser acceptance did not start. Failures include unsupported same-phone fixture uniqueness, authenticated cross-org rejection shape, call-pause pending-row expectation, real-DB tests freezing all timers, consent chronology, provider-off scheduling and next-step fault injection. They remain readiness blockers pending correction and rerun. The production build separately failed when Turbopack consumed the webpack-style offline font fixture; a CI-only fixture correction is assigned. Mutation runs remain gated on a green baseline.

Corrections for the first CI run are test/fixture-only: cross-org enrollment rejects at the real RLS training check; call-pause proves zero provider calls while retaining the failed breadcrumb and safe claim outcome; same-phone STOP uses phone_1/phone_2; four networked tests freeze Date only; consent order uses explicit timestamps; provider-off checks failed tick plus paused durable state; next-step fault injection reaches the actual second query. The build fixture now uses CI-only local font faces under Turbopack and preserves bundled font URLs in browser mode; font asset fetching is outside that offline compile check. Local bounded build passed the original font resolver failure but encountered the external dependency symlink, so fresh CI build remains required. One worker TypeScript attempt exhausted memory; no passing typecheck is claimed from that attempt. The required serialized commit verification follows.

Fresh CI run35209059214 at `16294ae2ed0a275f12e0e11554fa17fd20a0a160`: production build passed;229 database tests passed and two failed. Browser lane remained correctly blocked. All same-phone STOP variants, authenticated tenant gates, call-pause recovery, cancellation audit and injected next-step persistence failures passed. Remaining corrections: a fifth inherited networked test still freezes all timers; provider-off test must assert ordinary resume is denied and recover through explicit safe retry. Runtime safeguards remain unchanged.

Fresh CI run35209814889 at `3fcf38387157a1598423b52fd82378b1178131cd`: all231 database integration tests passed, production build passed, and cleanup completed. Browser4 passed/2 failed; Create remains disabled even after both fields retain expected values. No browser persistence/delivery proof or mutation proof is claimed. Verify run35209814816 passed completely. Browser behavior is under investigation; the earlier hydration-only hypothesis was insufficient.

Browser correction hypothesis: use real keyboard event sequences for the controlled Name/Description fields, retaining visible-value, enabled-Create, single-submit and persisted-state checks. Add capped, redacted failure diagnostics for page/console errors and failed scripts. The two multiroute cases receive a120-second overall cold-dev budget while per-assertion bounds and zero retries remain. This is not proof of a hydration root cause: a bounded standalone Base UI reproduction failed before the component loaded and yielded no valid evidence. Fresh CI must validate the interaction.

CI run35211173989 at `6bc97bf8d5342d52010e29e2a1880afedc659b3e`: database231/231 and production build passed; browser4/6 passed with the same disabled Create state despite keyboard input. Verify35211173952 passed. Keyboard-only hydration hypothesis is not supported as a sufficient fix. Inline Playwright JSON attachments were not physical files under the artifact upload directory, so diagnostics must be written explicitly and echoed after sanitization.

Installed Next development-origin checks reproduce a concrete configuration mismatch: origin127.0.0.1 with server hostname0.0.0.0 returns403 for /_next/hmr; explicit server hostname127.0.0.1 is allowed. The browser server is being bound explicitly to loopback. This proves the dev-resource mismatch, not yet the form-state root cause; further browser acceptance remains required.

A bounded esbuild/headless-browser reproduction using the actual Base UI packages reproduced the pre-hydration DOM/state mismatch for both fill and keyboard input; after hydration, input enabled Create. This demonstrates the failure class, not yet its cause in CI. The browser helper now waits at most10seconds for the version-pinned React host-props attachment before interacting. Missing attachment fails closed with physical/logged diagnostics; no button forcing or submission retry was added.

CI run35212300667 at `0d0a6c49ea6cb9be1671ebbbb5c9a6c0ec3d4213`: production build passed; database229/231 passed and two lifecycle assertions failed before browser execution. The database anchor was around10:50UTC: the fixture selected Guam at20:50 local, then its ten- and twenty-minute advances crossed the21:00 quiet-hours boundary. This is a fixture-window defect; production quiet-hours enforcement correctly held the sends. The replacement fixture selects an application clock/state with the entire simulated horizon inside the real send window, while retaining a separate database anchor for stale-claim ages and SQL recovery timestamps. No browser result is claimed for this candidate. Verify35212300702 passed completely. Logs: `/tmp/sandra-sequence-ci-canary5-clean-20260917.log`.
