# Sandra Migration Notes

These notes are for the upcoming move into `bmh-platform/apps/sandra/`.
Do not put secret values in this file.

## Runtime And Package Manager

- Current app: Sandra CRM.
- Current standalone repo path: `/Users/jarradhenry/Sites/Sandra`.
- Node engine in `package.json`: `>=22`.
- Current local Node observed while writing this note: `v25.8.2`.
- GitHub Actions currently use Node `24`.
- Current package manager: npm with `package-lock.json`.
- `package.json` has no `packageManager` field.
- pnpm is installed locally (`9.15.0` observed), but this repo is not using pnpm yet.

Framework and core versions:

- Next.js: `16.2.4`.
- React: `19.2.4`.
- React DOM: `19.2.4`.
- TypeScript: `^5`.
- Supabase JS: `^2.104.0`.

Migration watchpoint: the platform catalog currently targets pnpm 9 and a narrower shared version set. Sandra is ahead of the draft platform note's Next 15.1 baseline; do not downgrade during normal feature work. Reconcile this explicitly during Phase 1 catalog conversion.

## Commands

Current scripts:

- `npm run dev` -> `next dev`
- `npm run build` -> `next build`
- `npm run start` -> `next start`
- `npm run lint` -> `eslint`
- `npm run typecheck` -> `tsc --noEmit`
- `npm run test` -> `vitest run`
- `npm run test:integration` -> `vitest run --config vitest.integration.config.ts`
- `npm run test:rtl` -> `vitest run --config vitest.rtl.config.ts`
- `npm run test:e2e` -> `playwright test`
- `npm run test:e2e:prod-canary` -> `playwright test --config playwright.canary.config.ts`
- `npm run verify` -> `npm run typecheck && npm run test && npm run test:rtl`
- `npm run smoke:sequences-prod`
- `npm run smoke:ai-happy-prod`
- `npm run smoke:ai-escalation-prod`
- `npm run smoke:stop-prod`

Post-install hook:

- `prepare` runs `husky`.

## Environment Variables

Names only:

- `ADDRESS_VERIFIER_PROVIDER`
- `ADMIN_EMAILS`
- `APP_URL`
- `CASS_AUTOTRIGGER_MAX_ITEMS`
- `CI`
- `CRON_SECRET`
- `DIALPAD_API_KEY`
- `DIALPAD_FROM_NUMBER`
- `DIALPAD_WEBHOOK_SECRET`
- `E2E_QUIET_HOURS_NOW`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `MESSAGING_PROVIDER`
- `NEW_WEBHOOK_SECRET`
- `NEXT_PUBLIC_APP_URL`
- `NEXT_PUBLIC_JITTER_HOST`
- `NEXT_PUBLIC_SITE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_SUPABASE_URL`
- `OAUTH_STATE_SIGNING_SECRET`
- `OAUTH_TOKEN_ENCRYPTION_KEY`
- `PROD_ANON_KEY`
- `PROD_BASE_URL`
- `PROD_CANARY_ENV_TEST_ONLY`
- `PROD_CANARY_ENV_TEST_SHARED`
- `SKIP_INTENT_GATE`
- `SKIP_TRACE_PROVIDER`
- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_SIGNING_SECRET`
- `SMARTY_AUTH_ID`
- `SMARTY_AUTH_TOKEN`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TAILOR_2FA`
- `TAILOR_EMAIL`
- `TAILOR_LOGIN_URL`
- `TAILOR_PASSWORD`
- `TEST_SUPABASE_ANON_KEY`
- `TEST_SUPABASE_SERVICE_ROLE_KEY`
- `TEST_SUPABASE_URL`
- `TRACERFY_API_KEY`
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `TWILIO_MESSAGING_SERVICE_SID`
- `VERCEL_PROJECT_PRODUCTION_URL`
- `VERIFY_EMAIL`
- `VERIFY_PASSWORD`
- `VERIFY_URL`

Local ignored env files observed in the standalone checkout:

- `.env.local`
- `.env.test.local`
- `.env.prod-canary.local`
- `.env.dialpad-temp`

## Supabase

- Sandra owns its own Supabase projects and should not read other BMH apps' projects directly.
- Migrations live in `supabase/migrations/`.
- No `supabase/functions/` directory was present when this note was written, so no Supabase Edge Functions are currently in this repo.
- GitHub Actions auto-apply migrations to both prod and test from `.github/workflows/db-migrate.yml`.
- Project refs visible in workflow config:
  - prod: `copflsklaefwzipsrjqz`
  - test: `ncsngxlcyxylaeskiteu`

## GitHub Actions And CI

Current workflows:

- `.github/workflows/e2e.yml`
  - Runs on PRs and pushes to `main`.
  - Uses npm, Node 24, shared test Supabase project, Playwright Chromium.
  - Serialized with concurrency group `e2e-shared-test-project`.
- `.github/workflows/db-migrate.yml`
  - Runs on push to `main` when `supabase/migrations/**` changes.
  - Applies migrations to prod and test Supabase projects.
- `.github/workflows/canary-sequences.yml`
  - Weekday scheduled prod canary at 14:00 UTC.
  - Runs `scripts/smoke-sequences-prod.ts`.
- `.github/workflows/canary-sms.yml`
  - Weekday scheduled prod canaries at 14:30 UTC.
  - Runs AI happy path, AI escalation, and STOP keyword canaries.

Migration watchpoint: all workflows currently use npm and root-level paths. They will need conversion or replacement by platform path-aware Turbo/Vercel workflows after the app lives under `apps/sandra/`.

## eSign Retimestamp Recovery

- On 2026-09-02, two idempotent eSign migrations were renamed because later eSign migrations had already reached shared backends first:
  - `20260901181004_record_definitive_esign_template_provider_create_failure.sql` -> `20260902120000_record_definitive_esign_template_provider_create_failure.sql`
  - `20260902074814_esign_atomic_disconnect_state.sql` -> `20260902120100_esign_atomic_disconnect_state.sql`
- Supabase migration history is keyed by version, not SQL content. A backend that already has the old version rows will still treat the renamed files as pending fresh versions.
- That replay is expected for the QA backend that already applied the old filenames; the SQL bodies are idempotent, and the migration-safety gate now sees the fresh versions as newer than the latest applied eSign history instead of refusing them as out-of-order.
- Production only receives these through the normal `db-migrate-test.yml` -> `db-migrate-prod.yml` workflow chain after the test migration-safety gate passes.

## Vercel Cron And HTTP Endpoints

`vercel.json` defines these cron schedules:

- `/api/cron/notification-cleanup` -> `0 4 * * *`
- `/api/cron/phone-coverage-snapshot` -> `0 6 * * *`
- `/api/cron/sequence-tick` -> `*/5 * * * *`
- `/api/cron/sweep-stuck-skip-trace` -> `*/1 * * * *`

Important API routes:

- `/api/webhooks/dialpad/sms`
- `/api/webhooks/leads/[secret]`
- `/api/webhooks/skip-trace/[secret]`
- `/api/webhooks/slack/actions`
- `/api/webhooks/test-receiver`
- `/api/webhooks/twilio/sms`
- `/api/oauth/slack/start`
- `/api/oauth/slack/callback`
- `/api/oauth/google/start`
- `/api/oauth/google/callback`
- `/api/internal/jitter/dialer-batches/[id]`
- `/api/internal/jitter/dialer-batches/[id]/claim`
- `/api/internal/jitter/dialer-batch-items/[id]`
- `/api/internal/jitter/call-activities/by-jitter-attempt/[attemptId]`
- `/api/internal/jitter/call-activities/[id]/recordings`
- `/api/internal/jitter/call-activities/[id]/transcript`

Migration watchpoint: the `/api/internal/jitter/*` endpoints are Sandra-owned HTTP integration endpoints for Jitter writeback. Keep this as HTTP-boundary communication; do not convert it into app-to-app imports when both apps are in the monorepo.

## Non-Obvious Path And Dependency Issues

- `package.json` depends on `@sandra/tokens` via `file:../Sandra Design System`.
  - This sibling path will break once Sandra is under `apps/sandra/`.
  - During Phase 1, replace it with the platform-approved workspace/package strategy rather than preserving the relative sibling path.
- `scripts/edit-tailor-brands-privacy.ts` contains hard-coded `/Users/jarradhenry/Sites/Sandra` paths for local secrets.
- `scripts/twilio-console.ts` contains hard-coded `/Users/jarradhenry/Sites/Sandra` paths for local browser storage and artifacts.
- Several app-internal relative imports walk multiple directories upward. Those are normal local imports, but app-to-app imports must remain forbidden post-migration.

## Production Smoke And Canary Notes

- Prod smoke scripts intentionally hit production and must keep using env files/secrets, never chat-pasted values.
- SMS/AI canaries may spend small amounts through messaging providers.
- Production canary env must not point at the shared test Supabase project.

## Migration Guidance For Future Agents

- Keep Sandra feature work in this standalone repo until migration day.
- Keep the tree clean and committed; uncommitted work will not move cleanly through `git filter-repo`.
- Do not pre-refactor for the monorepo.
- Do not add app-to-app imports or direct reads of other apps' Supabase projects.
- If a structural change seems useful only because of the future monorepo, document it here or ask Jarrad before implementing it.
