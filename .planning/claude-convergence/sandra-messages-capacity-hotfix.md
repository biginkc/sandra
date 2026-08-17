# Sandra Messages Capacity Hotfix — Convergence Ledger

## Goal

Restore the Phase 1 Messages cockpit in production at real Sandra volume without loading or rendering the full active conversation history in one request.

## Plan source and scope

- Incident: production `/messages` failed closed after Phase 1 deployment because the complete inbox snapshot exceeded its 20,000-thread guard.
- PR: #373 (`codex/sandra-messages-snapshot-capacity`).
- Baseline: merged Phase 1 main `cd49e6af218ea46605ef27db27db62255740c62d`.
- Authority: the user-authorized Phase 1 completion/rollback profile.
- Explicit exclusion: no deferred-app work.

## Acceptance gates

- [x] Production app restored to the recorded pre-Phase-1 deployment after failed acceptance.
- [x] Full-window filter counts remain authoritative while each response is bounded.
- [x] Tenant, membership, suppression, DNC/noise, and cross-org ambiguity safeguards are preserved.
- [x] More than 20,000 active threads load successfully in the dedicated test database.
- [x] Page-two selection remains stable; hostile page values cannot overflow the RPC argument.
- [x] Manual review findings are fixed and reverified at the PR head.
- [x] Claude Fable completed a high-confidence adversarial review of PR #373 with no code blocker and authorized release-gate progression.
- [x] PR #373 exact-head CI, preview, and guarded test migration were green.
- [ ] Production migration and deployment are green.
- [ ] Fresh real-Chrome desktop and mobile Messages acceptance passes without console/runtime errors.

## Evidence

- Exact head: `271e7ca9c2a42d29cbea258dcdead5e4ec8f6c51`.
- Local full hook: 2,262 unit and 753 RTL tests passed.
- Focused exact-head: 42 unit/static and 44 RTL tests passed.
- Dedicated DB: migration rollback rehearsal, apply, and reapply passed.
- Production-scale regression: 20,005 conversations, truthful full counts, 200 returned rows, stable page-two selection.
- Test DB RPC timing at 20,005 conversations: approximately one second.
- Filter/DNC/assignment parity integration passed.
- Migration safety unit: 59/59 passed.
- Changed-file lint and diff check passed.
- Manual review: two P1 pagination findings accepted/fixed; anonymous Unassigned-count suggestion rejected as contrary to the existing signed-out UI/count contract.
- No secret/config changes and no deferred-app file paths in the branch.
- PR #373 merged as `88db5acc4fb1bff46d987388ab65cddd2c263c70`; migration `20260817100000` applied successfully to production.
- First production acceptance failed: both default and `hideDnc=0` `/messages` returned the route failure UI. Vercel logged `sms_inbox_thread_page_snapshot: canceling statement due to statement timeout`.
- Production app was immediately restored to recorded healthy deployment `dpl_6GrqcjtTjafe8uVNMwf7JXqHHFH3`; Chrome then showed the Messages cockpit with no route failure.
- Forward-only correction `20260817110000` leaves the applied migration immutable, carries a narrow full-window workset, and hydrates bodies plus detailed AI delivery fields only after selecting the bounded page.
- Corrected scale proof: 20,005 conversations / 40,010 varied-body messages; raw RPC succeeds inside an explicit 7-second PostgreSQL statement timeout, returns 200 rows with truthful counts, and the complete 19-case Messages integration suite passes.
- Correction manual review: two P1 test-proof findings accepted and fixed; both independent reviewers returned `BLOCKING: 0` and `APPROVE_CORRECTIONS: true`.

## Transport preflight

- Claude Code CLI installed and authenticated; Fable is explicitly required by the user.
- GitHub CLI and Vercel/GitHub checks reachable.
- Real Chrome control remains available for final production acceptance.

## Iterations

### Iteration 1

- Fable verdict: `NEXT_STEP`, confidence high, no code/migration/test blocker. Proceed through exact-head release gates and use production timeout/browser behavior as a hard gate.
- PR #373 merged only after exact-head Verify, preview, test migration, and manual review were green.
- Production acceptance refuted readiness because the page RPC exceeded the live statement timeout. Rolled back immediately.

### Iteration 2

- Engineering blocker classification: production database statement timeout, not rendering or Vercel deployment failure.
- Action: add forward migration `20260817110000` with narrow classification and page-only wide hydration.
- Verification: transaction rollback rehearsal, apply, reapply, 37 focused unit/static tests, 59 migration-safety tests, 19 Messages integration tests, typecheck, scoped ESLint, and diff check pass.
- Manual review found and closed two proof gaps: the superseding definition now owns complete contract assertions, and the production-shape test now uses multiple messages per conversation under a real database statement timeout.
- Next: open a correction PR, rerun Fable on the exact head, pass exact-head CI/test migration/preview, deploy, then repeat desktop/mobile real-Chrome acceptance.
