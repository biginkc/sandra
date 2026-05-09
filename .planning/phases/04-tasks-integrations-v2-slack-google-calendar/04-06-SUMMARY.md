---
phase: 04-tasks-integrations-v2-slack-google-calendar
plan: 06
status: complete
date: 2026-05-09
tags: [google, oauth, calendar, routes]
---

# Plan 04-06 Summary — Google OAuth Route Layer

## Outcome

Plan 04-06 is complete. Sandra now has the Google OAuth route-layer foundation needed by the Calendar dispatcher plan:

- `GET /api/oauth/google/start` authenticates the current Sandra user, signs a user-bound state value, builds a Google OAuth client, and redirects to Google's consent screen.
- `GET /api/oauth/google/callback` validates auth, code, and signed state before exchanging the code and storing encrypted Google user tokens through `upsertOAuthToken`.
- `src/lib/integrations/google/oauth.ts` wraps `googleapis` OAuth client creation, auth URL generation, and code exchange.

## Scopes And Consent

The Google OAuth URL requests exactly these scopes:

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/userinfo.email`

`buildGoogleAuthUrl` passes both required refresh-token settings verbatim:

- `access_type: "offline"`
- `prompt: "consent"`

It also passes `include_granted_scopes: true`.

## Implemented Files

- `src/lib/integrations/google/oauth.ts`
- `src/lib/integrations/google/oauth.test.ts`
- `src/app/api/oauth/google/start/route.ts`
- `src/app/api/oauth/google/callback/route.ts`
- `src/app/api/oauth/google/callback/route.test.ts`

## State Reuse Note

This plan reuses `signOAuthState` and `verifyOAuthState` from `src/lib/integrations/slack/state.ts`. Those helpers are provider-agnostic despite the current path. A future cleanup can move them to a shared OAuth state module without changing behavior.

## Test Coverage

Added or unskipped tests for:

- Google OAuth scopes.
- `generateAuthUrl` options: `access_type`, `prompt`, state, scopes, and granted-scope inclusion.
- OAuth code exchange success mapping, including expiry conversion from `expiry_date` milliseconds to ISO timestamp.
- `getToken` failure and missing `access_token` error paths.
- Missing `id_token`, failed `verifyIdToken`, and missing `refresh_token` graceful handling.
- Google callback redirects for unauthenticated users, missing/tampered state, provider exchange failures, and successful token upserts.

## Verification

- `npm run typecheck` passed.
- `npm test -- --run src/lib/integrations/google/oauth.test.ts src/app/api/oauth/google/callback/route.test.ts` passed: 15 tests.
