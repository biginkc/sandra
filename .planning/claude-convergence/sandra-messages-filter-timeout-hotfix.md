# Sandra Messages filter timeout hotfix

- Goal ID: `sandra-messages-filter-timeout-hotfix`
- Depends on: none
- Baseline: `60bdf90accf38610b348c754eabc3e714e2f2625`
- Production deployment at incident: `dpl_6cShHwRk8fU9vZkToQ1DwAo8i6yN`
- Incident: authenticated Messages filter navigation reaches the server, but `sms_inbox_thread_page_snapshot` exceeds the production statement timeout and the whole route renders `Couldn't load Messages`.

## Acceptance gates

- Mine, Escalated, and Sandra Dispo each settle from a neutral filter in production Chrome.
- Unread, Needs Outcome, Mine, Escalated, Sandra Dispo, No owner, All, Unknown, and Dismissed each settle with the correct URL and without the route failure.
- Pending controls use the approved muted state without a spinner.
- No statement-timeout or browser-console error appears during the production filter matrix.
- Filter membership, full badge counts, tenant visibility, DNC/suppression, AI-review, and lead-only assignment semantics are preserved.
- Any database change is forward-only, rehearsed on PostgreSQL 17, and has a recorded rollback point.
- Focused tests, integration tests, typecheck, lint, build, manual review, exact-head Claude review, CI, deployment, and production browser acceptance pass.

## Evidence ledger

- FAIL — Production Chrome: Messages falls into `Couldn't load Messages` after filter navigation.
- FAIL — Production server log: `sms_inbox_thread_page_snapshot: canceling statement due to statement timeout`.
- PASS — GitHub and Vercel access available.
- PASS — Claude CLI authenticated; desktop Claude control is unavailable in this environment, so exact-head review will use the CLI fallback.
- PASS — Isolated clean worktree based on current `origin/main`.
- PASS — Test-DB apply/rollback rehearsal: function rewrite, index readiness, timeout configuration, and exact rollback all succeeded inside one transaction.
- PASS — Production repeatable-read rehearsal applied the exact migration and rolled it back without persistent change. The old All baseline was 6.249s. All seven RPC filters then passed twice between 1.948s and 2.935s.
- PASS — Production parity: all count documents matched the frozen old function exactly; both optimized All documents matched the old full JSON exactly.
- PASS — Production rollback: function definition hash/config returned to the exact before state and the probe index count returned to zero.
- PASS — Production shape measured without PII: 53,267 threads, 73,280 eligible 90-day SMS rows, and 24 pending reviews.
- PASS — Expanded 20,005-thread integration scale case exercised All, Unread, Needs Outcome, Mine, No owner, Escalated, and Sandra Dispo under the candidate migration.
- PASS — Parallel SQL design, production-scale validation, and adversarial migration/rollback review completed with no blocking findings.
- PASS — Full repository gate: typecheck, 2,811 unit/static tests, and 929 interface tests.
- PASS — Candidate migration applied to the hosted test database, then 19 Messages integration cases plus 3 Sandra Dispo/assignment/rollback cases passed; the candidate rollback ran automatically afterwards.
- PASS — Fallow reported no changed-file findings; inherited dependency/duplication/complexity leads were outside this hotfix.
- WATCH — A normal index build briefly blocks message writes. The active campaign remains paused through migration and production acceptance.

## Rollback

- Record the final pre-merge production deployment and main SHA immediately before merge.
- Database changes must be delivered as a forward migration; recovery is a forward restore of the prior function body, not deletion of applied migration history.
