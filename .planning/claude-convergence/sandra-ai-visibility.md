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

## Notes
- The clean worktree had no `.env.test.local`; an ignored symlink to the main checkout's existing test env file was used for integration tests. No secret values were copied or printed.
- `src/app/api/cron/sequence-tick/route.ts` had an unrelated local modification and is intentionally excluded from this PR.
