# Sandra AI Visibility Filters

## Goal
Implement Sandra thread-level AI visibility on `/messages`: mascot `Escalated` and `Handled` filters, durable thread state, Sendillo delivery rollup for Sandra-generated outbound messages, review, Claude approval, merge, and production verification.

## Baseline
- Branch: `codex/20260624-sandra-ai-visibility`
- Base: `origin/main` at `e1f953c8ef5f5fb7e42bdf9fbcd70ba0350bbcb1`
- Worktree: `/Users/jarradhenry/Sites/BMH apps/_worktrees/sandra-ai-visibility`
- Plan source: Claude-approved v3 architecture from this thread, with final chip order `Unread`, `Needs Outcome`, `Mine`, mascot `Escalated`, mascot `Handled`, then the rest.

## Acceptance Gates
- Add forward-only `message_threads` Sandra AI state columns and partial status index.
- New non-duplicate inbound clears prior Sandra state; duplicate inbound replay does not.
- AI sent/auto-closed/opted-out records handled; AI escalated records escalated; skipped stays null after clear.
- Sendillo status callbacks roll delivery fields up only when the matched outbound has `metadata.generated_by = "ai_responder_v1"` and a conversation id.
- Messages UI exposes mascot `Escalated` and `Handled` filters and row status/delivery labels in the requested order.
- Focused unit, RTL, integration, lint, and typecheck gates pass.
- Manual code review runs after PR creation; valid findings fixed.
- Claude approves the final PR head before merge.
- Merge completes and production deployment/behavior is verified.

## Evidence
- Test DB migration applied with `supabase db push --db-url <redacted test db url>` after dry-run showed only `20260624143000_sandra_ai_message_thread_state.sql`.
- Unit: `npm run test -- src/lib/messages/ai-responder-thread-state.test.ts src/lib/messages/list-threads.test.ts 'src/app/(dashboard)/messages/inbox-filter-resolve.test.ts'` passed, 51 tests.
- RTL: `npm run test:rtl -- 'src/app/(dashboard)/messages/inbox-filters.test.tsx' 'src/app/(dashboard)/messages/inbox-thread-list.test.tsx'` passed, 22 tests.
- Typecheck: `npm run typecheck` passed.
- Integration: `npm run test:integration -- src/app/api/webhooks/sendillo/status/route.integration.test.ts src/app/api/webhooks/dialpad/sms/route.integration.test.ts src/lib/ai-responder/dispatch.integration.test.ts` passed, 69 tests.
- Lint: `npm run lint -- <changed files>` passed.

## Manual Review
- Used `custom-manual-code-review` on PR #312 with three read-only lanes: data/state transitions, Messages UI/filter semantics, and release/migration/test hygiene.
- Accepted and fixed: Sendillo/status helper could roll thread delivery state forward even when the guarded message update matched zero rows. Fix: return updated ids from the Supabase update and skip the thread rollup when no row was touched. Added `src/lib/messaging/status-events.test.ts`.
- Accepted and fixed: Messages realtime list could refresh after `messages` update before the later `message_threads` Sandra rollup. Fix: subscribe to `message_threads` changes and refresh.
- Accepted and fixed: no-user direct URLs for `mine` / `unassigned` could show invisible filter states. Fix: normalize those filters to `all` when there is no current user.
- Accepted and fixed: failed delivery reason was title-only. Fix: add `aria-label` with the full delivery reason while keeping the visible chip compact.
- Accepted and mitigated: migration lock posture. Fix: add bounded lock/statement timeouts and create the check constraint as `not valid` before validating it. `CREATE INDEX CONCURRENTLY` was not used because this repo has no current Supabase migration convention for transaction-sensitive concurrent index statements.
- Claude review returned `APPROVED` with medium-high confidence on head `7c2ef42`, with no blocking findings. Claude noted the new `message_threads` realtime subscription needed the table in the Supabase realtime publication; accepted and fixed by adding an idempotent publication update to the migration.
- The same publication update was applied to the shared Sandra test DB and verified with `pg_publication_tables`, because the test DB had already recorded the earlier migration version during pre-PR verification.
- Static analysis: `fallow audit --base origin/main --format compact` and diff-file audit were run. Findings were inherited/generated unused exports/deps, existing complexity in old hot functions, and test clone groups; no additional blocking PR defect survived review after the fixes above.
- Provider docs checked: Supabase JavaScript update docs and Supabase database migration docs. Public Sendillo/Cendilio status-webhook docs were not discoverable; Sendillo-dependent claims were reviewed against the local adapter contract and tests only.
- Secret review: no new secret-bearing environment variables or credential values were added. Existing test placeholders remained fake values. 1Password storage was not inspected because no new secret was introduced.

## Review Fix Verification
- `npm run test -- src/lib/messaging/status-events.test.ts 'src/app/(dashboard)/messages/inbox-filter-resolve.test.ts'` passed, 26 tests.
- `npm run test:rtl -- 'src/app/(dashboard)/messages/inbox-thread-list.test.tsx' 'src/app/(dashboard)/messages/inbox-filters.test.tsx'` passed, 23 tests.
- `npm run test:integration -- src/app/api/webhooks/sendillo/status/route.integration.test.ts` passed on rerun, 13 tests. The first run had one transient missing-row failure on the shared test DB; the isolated rerun passed.
- `npm run typecheck` passed after review fixes.
- `npm run lint -- <review-fix files>` passed with no warnings after cleanup.
- GitHub Playwright on head `7c2ef42` failed `e2e/cockpit-realtime.spec.ts` because the client subscribed to `message_threads` before the table was in the realtime publication; the channel did not deliver the existing `messages` event. Migration/test-DB publication fix added after this failure.

## Notes
- The clean worktree had no `.env.test.local`; an ignored symlink to the main checkout's existing test env file was used for integration tests. No secret values were copied or printed.
- `src/app/api/cron/sequence-tick/route.ts` had an unrelated local modification and is intentionally excluded from this PR.
