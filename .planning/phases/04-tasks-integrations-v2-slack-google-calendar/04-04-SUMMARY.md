---
phase: 04-tasks-integrations-v2-slack-google-calendar
plan: 04
status: complete
date: 2026-05-09
tags: [schema, supabase, types, checkpoint]
---

# Plan 04-04 Summary — Schema Checkpoint + Type Regeneration

## Outcome

Plan 04 is complete. The migration checkpoint passed for the current migration numbers:

- OAuth token storage: `060_user_oauth_tokens.sql`
- Integration preferences and task external IDs: `061_user_integration_prefs.sql`

The original plan referenced `053` and `054`, but current `origin/main` had already advanced through migration `059` before Phase 04 execution.

## Migration Evidence

The main migration workflow after PR #210 completed successfully for both jobs:

- Workflow: `Apply Supabase migrations to prod and test`
- Run ID: `25610942536`
- Prod job: passed
- Test job: passed

Read-only live schema probes also passed on both Supabase projects:

- `user_oauth_tokens` selectable
- `user_integration_prefs` selectable
- `tasks.google_calendar_event_id`, `tasks.slack_channel_id`, and `tasks.slack_message_ts` selectable

## Types Regenerated

`src/lib/supabase/types.ts` was regenerated from the prod project:

```bash
supabase gen types typescript --project-id copflsklaefwzipsrjqz --schema public > src/lib/supabase/types.ts
```

The generated diff includes:

- `user_oauth_tokens`
- `user_integration_prefs`
- `tasks.google_calendar_event_id`
- `tasks.slack_channel_id`
- `tasks.slack_message_ts`
- RPCs: `get_oauth_token`, `upsert_oauth_token`, `delete_oauth_tokens`
- Previously-migrated dialer/call tables that were missing from the checked-in generated types

## Verification

- Type presence check passed for both new tables, all three task columns, and all three OAuth RPCs.
- `npm run typecheck` passed.
- `npm run test:integration -- src/lib/integrations/tokens/store.integration.test.ts` passed against the migrated test Supabase project.
- `npm run verify` passed.
