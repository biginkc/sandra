---
phase: 04-tasks-integrations-v2-slack-google-calendar
plan: 05
status: complete
date: 2026-05-09
tags: [slack, oauth, security, routes]
---

# Plan 04-05 Summary — Slack OAuth Route Layer

## Outcome

Plan 04-05 is complete. Sandra now has the Slack OAuth route-layer foundation needed by the Slack dispatcher and interactivity webhook plans:

- `GET /api/oauth/slack/start` authenticates the current Sandra user, signs a user-bound state value, and redirects to Slack OAuth with the required bot scopes.
- `GET /api/oauth/slack/callback` validates auth, code, and signed state before exchanging the code and storing encrypted Slack bot/user token rows through `upsertOAuthToken`.
- `/api/oauth/*` is public at middleware level so OAuth callbacks can reach their own route-level auth/state checks.
- `OAUTH_STATE_SIGNING_SECRET` is documented in `.env.example`.

## Implemented Files

- `src/lib/integrations/slack/signature.ts`
- `src/lib/integrations/slack/state.ts`
- `src/lib/integrations/slack/oauth.ts`
- `src/app/api/oauth/slack/start/route.ts`
- `src/app/api/oauth/slack/callback/route.ts`
- `src/lib/supabase/middleware.ts`
- `.env.example`

## Test Coverage

Added or unskipped tests for:

- Slack `v0=` HMAC signature verification, timestamp replay rejection, tamper rejection, and length mismatch rejection.
- OAuth signed state generation/verification, including user mismatch, malformed values, expiration, future timestamps, and tampering.
- Slack OAuth URL generation and `oauth.v2.access` exchange mapping/error handling via mocked `@slack/web-api`.
- Slack callback redirects for unauthenticated users, missing/tampered state, provider exchange failures, and successful bot/user token upserts.
- Middleware public-path coverage for `/api/oauth/*` and `/api/webhooks/*`.

## Verification

- `npm test -- --run src/lib/integrations/slack/signature.test.ts src/lib/integrations/slack/state.test.ts src/lib/integrations/slack/oauth.test.ts src/app/api/oauth/slack/callback/route.test.ts src/lib/supabase/middleware.test.ts` passed.
- `npm run typecheck` passed.
- `npm run verify` passed:
  - Unit: 905 passed, 21 todo.
  - RTL: 307 passed, 4 todo.

## Notes For Later Plans

- `SLACK_BOT_SCOPES` requests `chat:write`, `im:write`, `users:read`, and `users:read.email`.
- `SLACK_USER_SCOPES` is intentionally empty for V2; the callback still stores a user token row if Slack returns one in a future scope expansion.
- The bot token row stores `externalAccountId` as the installing Slack user ID so Plan 04-07 can map Slack interactions back to Sandra users.
