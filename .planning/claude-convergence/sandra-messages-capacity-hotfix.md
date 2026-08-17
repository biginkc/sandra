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
- [ ] Claude Fable returns `DONE` with high confidence for the exact PR head.
- [ ] Required CI, preview, and guarded test migration are green at the exact PR head.
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

## Transport preflight

- Claude Code CLI installed and authenticated; Fable is explicitly required by the user.
- GitHub CLI and Vercel/GitHub checks reachable.
- Real Chrome control remains available for final production acceptance.

## Iterations

### Iteration 1

- Pending exact-head Fable readiness review.
