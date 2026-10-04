# Norma schema-first CI contract proposal

Local preparation only; no publication or workflow change is admitted. Base schema candidate827e217ff0cf80b55135a37582091958a7246898 remains published unchanged as draft792. Runtime58996222837799f4feb3a47460ee59ccf0afd381 remains draft793. SQL20261004090000 is byte-identical, SHA256 f386ab9e07d28372acdc37d088a82c153eba8dd2019532964d87a6a1680c3466. No existing assertion or test has been changed, skipped or weakened. The current default stress command still tests the unsupported mixed combination and will not become green from this proposal alone.

## Failure classification

Published792 run37189630910 failed17/131 with cleanup successful. These are the exact source locations and distinct failures; the two concurrent-completion failures appear twice in the log but represent one failed test, and the two mutation names are truncated identically by Vitest.

| Failed test (source line in published827e) | Count | Classification and evidence |
|---|---:|---|
| races72: voicemail webhook before send response |1| Obsolete terminal assertion: requested attempt2 is the SQL's explicit first confirmed no-answer transition. No final outbox/event is expected yet. |
| races129: voicemail webhook versus reconciliation |1| Same terminal assertion; concurrent first completions must schedule exactly one retry, retain holds, and emit one attempt event. New forced20-worker SQL race verifies this. |
| races265: no-answer before inbound reply |1| Obsolete pause release expectation: first non-connect retains norma_call hold; inbound reply must still upgrade protection. Paired runtime suite tests final second-call/reply interleavings. |
| races303: cleanup selected pause, reply upgrade, then no-answer |1| Obsolete completed-status assertion. Protection remains required; no permissive pause assertion is substituted. |
| races326: cleanup without reply |1| Obsolete release timing: cleanup cannot resume while retry request is open. |
| races336: existing softphone pause, no-answer, sweep |1| Same premature release expectation; terminal second no-answer is the release boundary. |
| races405: voicemail fault on norma_notifications |1| Obsolete fault boundary: attempt1 intentionally writes no notification. Failure/rollback must be injected at terminal completion. New post-DDL rollback test does that, checks request/pauses/events/outbox unchanged, then concurrent replay applies once. |
| races603: whole-file invariants |1| Mixed: at-most-one-send and exactly-one-call-ID invariants are obsolete under two calls. dispatch_rejected after a placed first call is also an actual unsupported legacy-worker hazard (fresh retry expired/rejected); do not erase it as assertion drift. |
| random40: seeds101,202,303,404,505 (80 lifecycles each) |5| Mixed contract/hazard: one-call cardinality and first-ID checks conflict with retry; legacy workers can dispatch an unfenced/metadata-less retry or expire it based on original created_at. These runs do not demonstrate a pinned SQL defect, but do refute unrestricted old-runtime/new-schema operation. |
| regress-dnc-lock35: no_answer_status after DNC lock |1| Obsolete terminal status: retry is queued; DNC must prevent actual retry dispatch and task writes. Schema queuing alone is not authorization to call; dial-time recheck is runtime responsibility. No DNC assertion is relaxed. |
| teeth137: release ignores do-not-contact mutant |1| Obsolete scene boundary: first no-answer no longer calls release; baseline scene expects completed. Preserve this mutant on matched legacy stack and the reviewed paired runtime terminal scene. |
| teeth137: release ignores pause reason mutant |1| Obsolete scene boundary: release_result is null while retry remains open; reason_changed is expected only when terminal release actually runs. Preserve the mutant and final protected-pause check. |
| Total |17| No genuine SQL regression established by these failures. This is a bounded conclusion, not proof of absence. The mixed writer hazards remain release blockers. |

## Smallest proposed mandatory architecture

All applicable stages must pass, fail closed, use disposable loopback databases with successful owned cleanup, and report exact source/schema identities. Never substitute baseline-only green for schema acceptance. Root must admit the precise CI wiring and updated source heads before publication. This local delta changes tests/documentation only, not workflow behavior.

1. **Matched pre-DDL legacy regression:** run all unchanged131 legacy runtime stress tests against the six legacy Norma migrations. Use the existing regression-exclusion facility for exactly20261004090000_norma_call_twice.sql and exclude only the new post-DDL test file from this stage, because that file explicitly requires attempt. Its coverage is mandatory in stage2. Mutation teeth, all five80-lifecycle seeds, race assertions and DNC guards remain intact. Refuse any additional exclusions or reduced lifecycle/seed overrides in the future CI wiring.
2. **Full post-DDL schema contract:** apply every Norma migration, including the hash-pinned retry SQL, and run schema-contract.integration.test.ts. The test checks attempt exists, forces20 SQL workers to wait on a real request row lock before releasing them, then asserts one claim/transition/effect winner. It tests attempt2 claim fencing, stale/forged call ID refusal, terminal replays, no third attempt, protected versus eligible pause release, and rollback on terminal outbox failure. Its negative legacy reconciliation test must remain visible as a hazard receipt, not be described as compatibility approval.
3. **Upgrade and held-period SQL compatibility:** the existing20 retry migration integration tests replay pre-upgrade data, preserve protected/review rows, exercise legacy SQL signatures, default/malformed attempts, late results and documented mixed-version hazards. These run with full post-DDL SQL. Transactional tests cannot replace stage2's committed concurrency proof.
4. **Paired runtime candidate:** draft793's ordinary full stress gate runs its attempt-aware application, fake provider and two-call invariants against full schema (existing37189648452 passed). It must retain the maintenance helper in the future production assembly. No test-only shim or direct SQL completion can stand in for the production runtime here.
5. **Serving hold evidence:** source helper on main, temporary main Git deployment hold, exact manually deployed artifact/flag1, actual old action/cron execution bounds, propagation/drain deadline, retained URLs and external writer dispositions. Unknown writers or an old worker surviving after DDL stop release. This is an admission prerequisite outside tests; no schema test claims serving quiescence. Root owns main:false restoration.

A future runner should select this schema-only profile by explicit admitted workflow/job, not infer it from a mutable flag or silently hide a migration. The paired runtime workflow retains its full current stress lane. Any combined updated assembly must recheck applicable stages and exact reviewed hashes. No workflow implementation or bypass is included here.

## Local commands and evidence

The loopback source is a private owned container, restored strictly with ON_ERROR_STOP from the previously captured schema-only baseline. Scratch databases commit across real pooled connections and drop at suite completion. No hosted credentials, provider, Slack, AI or calls are used. The initial new test fixture incorrectly seeded two live enrollments on one property, which the actual index rejected; it was corrected to valid single-enrollment fixtures and separate eligible/protected terminal cases. An expected SQL outcome was corrected from runtime in_flight to actual SQL already_open. The negative aging fixture uses the existing scratch clock helper rather than overriding the immutable created_at trigger. These were new-test defects, not application changes.

```sh
# Required legacy stage (source URL must be explicitly supplied and loopback).
NORMA_STRESS_EXCLUDE_MIGRATIONS=20261004090000_norma_call_twice.sql \
  npx vitest run --config vitest.norma-stress.config.ts \
  --exclude src/lib/norma/stress/schema-contract.integration.test.ts
# Required post-DDL stage: exclusion unset; new test refuses absent attempt.
npx vitest run --config vitest.norma-stress.config.ts \
  src/lib/norma/stress/schema-contract.integration.test.ts
# Required20 upgrade tests, using TEST_SUPABASE_DB_URL for the same private source.
npx vitest run --config vitest.local-integration.config.ts \
  supabase/migrations/20261004090000_norma_call_twice.integration.test.ts
```

Observed: unchanged legacy131/131 passed,20 upgrade tests passed,9 post-DDL tests passed (including one intentionally asserted legacy expiry hazard); typecheck/lint passed. The baseline run discovered its original10 files before the new file existed; the documented explicit exclusion makes that stage reproducible after this delta. These are local results, not replacement published CI receipts. Full application verify is reused from the unchanged827e source; no full verify claim is made for this test-only delta. Intermediate Opus review remains required; final release review is not yet admissible.
