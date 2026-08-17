# Sandra High-Fidelity Redesign Phase 1 convergence ledger

## Goal

Implement the Claude-approved Overview, Messages, Calendar, and Lead Detail redesign from visual references without importing prototype code; preserve production behavior and safety; independently review, merge, deploy, and prove the happy path in real production Chrome.

## Authority and sources

- User authorization in the active Codex task permits autonomous implementation, review, migration, PR, merge, deployment, production acceptance, and rollback for this exact Phase 1 release.
- Design package: `/Users/jarradhenry/Sites/BMH apps/Design package delivery.zip`.
- Current contract: `CODEX-HANDOFF.md` v2 plus design-contract commit `c662471`; stale `DESIGN-NOTES.md` does not override them.
- Prototype HTML and JavaScript are visual references only and must not be copied into Sandra.
- Baseline: `d63d1f33c51dd71f3bf73835fd559efba6eb95c9` (`origin/main` at execution start).
- Isolated worktree: `/Users/jarradhenry/Sites/BMH apps/_codex_worktrees/sandra-redesign-phase1`.

## Hard boundaries

- No deferred Phase 2 workflow: no atomic dated Follow-up, permanent-DNC-from-Messages, phone-specific wrong-number mutation, or unsupported Outbox row state/actions.
- Never weaken consent, DNC, tenant isolation, authorization, audit history, or truthful failure states.
- Preserve every existing action, route, accessible contract, semantic selector, and required `data-testid`.
- Do not send real SMS, calls, emails, payments, or consume newly paid provider resources.
- Keep credentials and private customer information out of prompts, logs, screenshots, commits, and artifacts.

## Adversarial integration decisions

1. PR #370's historical cancel-chain rewrite was rejected after exact-head review because it destroyed the recorded `completed/rescheduled` fact and still left immutable DNC history visibly stale. The unpublished migration now preserves every audit row and Calendar hides a reschedule predecessor only when the same organization and chain has a cancelled appointment.
2. PR #369 was rejected as unsafe: its five-row global claim burned attempts on unrelated work, its completion kick could only claim unrelated rows, and its four-second deadline could not reach Google. The first task-scoped replacement was also rejected because a delayed request could claim a newer mutation on the same task. Lifecycle RPCs now return the exact ledger id, inline sync claims only that id, completion never kicks, and the bounded worker gets ten seconds.
3. PR #368 is reused only for its functional Calendar engine through `4a03e4c`; the presentation is replaced. Its old migration number is renamed after the current main ledger.
4. Calendar Month is always 42 days / six Sunday-start weeks, uses one snapshot RPC, and keeps per-week caps. On narrow screens that same range becomes a labelled Month agenda with the Month tab visibly active; the seven-column grid remains desktop-only.

## Completed checkpoints

- `65744db` — DNC-safe cancel-chain visibility migration (`20260816090000`), test-database rehearsal/apply, and locked-history integration proof.
- `b965cbd` — exact-task inline calendar sync claim (`20260816093000`), connected-provider budget correction, and unrelated-backlog attempt proof.
- `89a7907`..`b14881d` — PR #368 functional engine replayed while preserving main's deterministic notification test.
- `f6b3ca6` — fixed six-week Month range, migration renumber (`20260816100000`), approved Calendar presentation, shared five-tone contract, and test-database rehearsal/security tests.
- `edda9f0` — server-page proof that Month supplies six adjacent windows and 42 days and fails visibly on RPC error.
- `8c8158b` — daily-work-first Overview, explicit task-load failure, and narrow navigation targets; existing bell behavior preserved.
- `bed541d` — cancel-chain tenant isolation, deterministic lock order, and concurrent DNC-ratchet proof.
- `dbe99be` — Lead Detail hierarchy, one ordered task/appointment timeline, truthful fail-closed SMS restrictions, and preserved DNC/read models.
- `8fa318f` — narrow list-or-detail Messages cockpit, persistent filter URL state, truthful queue failures, stage/escalation labels, and keyboard focus recovery.
- `34a02b4` — non-mutating cancel-chain visibility, shared week/month single-snapshot reads, exact-ledger lifecycle receipts and claims, replay/concurrency proof, and dedicated-test-database reapply proof.
- `085a538` — 44px narrow controls, truthful Calendar scope/timezone captions, visible mobile Month state, and one shared DST/overnight-safe time-range formatter.
- `7843e05` — exact-task Lead retry receipts, immediate Messages permanent-lock convergence, property-level DNC filtering, queue-stat failure truth, and Overview Retry.

## Verification evidence so far

- Full commit hooks through `7843e05`: typecheck, 2,216 unit tests, and 705 RTL tests pass. One unrelated Prospects menu timing failure reproduced once before the first whole-change review, then its exact test and all later complete hooks passed.
- Calendar Month migration: transaction rehearsal rolled back cleanly, exact migration applied cleanly to the dedicated test database, 7/7 migration integration tests pass.
- Cancel-chain and targeted inline-claim migrations were separately rehearsed/applied in the dedicated test database with their integration suites passing.
- Overview/shell independent review: CLEAN.
- Lead Detail adversarial review: three findings fixed (nearest appointment ordering, terminal/landline SMS gating, partial-read visibility), then CLEAN.
- Messages adversarial review: queue refresh truthfulness and stale-thread mobile recovery/focus findings fixed across non-empty and empty filters, then CLEAN.
- First whole-change manual review at `f9af052`: REJECTED by all three independent slices. Database/security found destructive history rewriting and non-exact inline claims; route review found cross-task retry, stale DNC controls, incomplete DNC filtering, and false queue zeroes; quality review found undersized narrow controls, missing timezone truth, and DST/overnight formatting errors.
- Corrective database evidence at `34a02b4`: initial rehearsal/apply and reapply rehearsal/apply passed on the dedicated test project; 18 focused migration/integration tests, including simultaneous claims, delayed old-ledger isolation, and book/reschedule/reassign replay receipts, pass. Migration safety is 59/59.
- Corrective UI/workflow evidence through `7843e05`: 168 focused unit tests and 230 focused RTL tests pass independently in addition to the full hooks.

## Active execution lane

- Root integration: exhaustive exact-head review, Claude convergence, final build/database/browser evidence, PR/CI, migration, merge, deployment, and production acceptance.

## Acceptance gates

- [ ] Overview, Messages, Calendar, Lead Detail, and narrow shell match the approved Phase 1 contract without losing existing behavior.
- [ ] Changed-file lint, typecheck, unit, RTL, integration, migration guard/rehearsal, production build, and relevant E2E are clean.
- [ ] Exhaustive manual code review is clean on the exact merge candidate; every valid material finding is fixed and re-reviewed.
- [ ] Claude Fable returns `DONE` with high confidence on the exact reviewed head.
- [ ] PR declares `Depends on: none` (or the freshly verified dependency) and all CI/preview gates pass.
- [ ] Additive migrations are applied only after final-base rehearsal and rollback proof.
- [ ] Merge/deploy rollback point is recorded; production deployment succeeds.
- [ ] Fresh system Chrome proves desktop 1440x900 and mobile 390x844 outcomes, including console/network inspection and visible screenshots.
- [ ] PR #368/#369/#370 are closed or superseded only after replacement proof.

## Current state

The first whole-change candidate was correctly rejected. Its three correction families are implemented at `7843e05` with full hooks and dedicated-database evidence clean. Exact-head whole-change re-review and Claude convergence are next. No merge, production migration, production deployment, provider send, or production browser mutation has occurred in this execution block yet.
