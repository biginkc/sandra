---
phase: 04-tasks-integrations-v2-slack-google-calendar
plan: 01
subsystem: integrations
tags: [slack, google-calendar, oauth, test-scaffold]

requires: []
provides:
  - Slack and Google Calendar SDK dependencies
  - Phase 04 OAuth/integration env var template
  - Test scaffold files for downstream TDD waves
affects: [04-02, 04-03, 04-05, 04-06, 04-07, 04-08, 04-09, 04-10]

key-files:
  modified:
    - .gitignore
    - package.json
    - package-lock.json
    - .planning/ROADMAP.md
  created:
    - .env.example
    - src/lib/integrations/tokens/oauth-secret.test.ts
    - src/lib/integrations/tokens/store.test.ts
    - src/lib/integrations/tokens/store.integration.test.ts
    - src/lib/integrations/slack/signature.test.ts
    - src/lib/integrations/slack/blocks.test.ts
    - src/lib/integrations/slack/dispatch.test.ts
    - src/lib/integrations/google/dispatch.test.ts
    - src/app/api/oauth/slack/callback/route.test.ts
    - src/app/api/oauth/google/callback/route.test.ts
    - src/app/api/webhooks/slack/actions/route.test.ts
    - src/app/api/webhooks/slack/actions/route.integration.test.ts
    - src/app/(dashboard)/settings/integrations/form.test.tsx

requirements-completed: [SLACK-01, CAL-01, INTEG-01]
completed: 2026-05-09
---

# Phase 04 Plan 01: Wave 0 Scaffold Summary

Plan 01 is complete. This is dependency and test scaffolding only; no Slack or Google behavior ships in this slice.

## Dependencies

- `@slack/web-api`: `^7.15.2` in `package.json`, resolved to `7.15.2` in `package-lock.json`.
- `googleapis`: `^171.4.0` in `package.json`, resolved to `171.4.0` in `package-lock.json`.

## Env Template

Created `.env.example` with empty keys only:

- `SLACK_CLIENT_ID`
- `SLACK_CLIENT_SECRET`
- `SLACK_SIGNING_SECRET`
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `OAUTH_TOKEN_ENCRYPTION_KEY`

Also added a narrow `.gitignore` exception for `.env.example` so real `.env*` files remain ignored while the template is tracked.

## Test Scaffolds

- `src/lib/integrations/tokens/oauth-secret.test.ts`
- `src/lib/integrations/tokens/store.test.ts`
- `src/lib/integrations/tokens/store.integration.test.ts`
- `src/lib/integrations/slack/signature.test.ts`
- `src/lib/integrations/slack/blocks.test.ts`
- `src/lib/integrations/slack/dispatch.test.ts`
- `src/lib/integrations/google/dispatch.test.ts`
- `src/app/api/oauth/slack/callback/route.test.ts`
- `src/app/api/oauth/google/callback/route.test.ts`
- `src/app/api/webhooks/slack/actions/route.test.ts`
- `src/app/api/webhooks/slack/actions/route.integration.test.ts`
- `src/app/(dashboard)/settings/integrations/form.test.tsx`

All placeholders use `it.todo(...)`, so later implementation waves have explicit pending behaviors without silently passing empty tests.

## Verification

- `npm run typecheck` passed.
- `npm test -- --run` passed with 864 passed and 37 todo.
- `npm run test:rtl` passed with 307 passed and 4 todo.
- `npm run test:integration -- src/lib/integrations/tokens/store.integration.test.ts src/app/api/webhooks/slack/actions/route.integration.test.ts` passed with 5 todo.
- `npm run verify` passed.
- Prettier check passed for package files, `.env.example`, and all new scaffold tests.

## Next

Proceed to Plan 04-02: `user_oauth_tokens` migration, pgcrypto helper functions, `OAuthSecret`, and token store implementation.
