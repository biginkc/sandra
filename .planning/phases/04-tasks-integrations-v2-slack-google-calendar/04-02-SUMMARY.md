---
phase: 04-tasks-integrations-v2-slack-google-calendar
plan: 02
subsystem: integrations
tags: [oauth, pgcrypto, supabase, rls, tokens]

requires:
  - phase: 04-tasks-integrations-v2-slack-google-calendar/04-01
    provides: SDK dependencies and test scaffold files
provides:
  - user_oauth_tokens migration with encrypted token storage
  - service-role RPC contract for get/upsert/delete OAuth tokens
  - OAuthSecret redaction wrapper
  - token store helpers for downstream OAuth and dispatcher plans
affects: [04-03, 04-04, 04-05, 04-06, 04-07, 04-08, 04-09, 04-10]

key-files:
  modified:
    - .planning/ROADMAP.md
    - src/lib/integrations/tokens/oauth-secret.test.ts
    - src/lib/integrations/tokens/store.test.ts
    - src/lib/integrations/tokens/store.integration.test.ts
  created:
    - supabase/migrations/060_user_oauth_tokens.sql
    - src/lib/integrations/tokens/oauth-secret.ts
    - src/lib/integrations/tokens/store.ts

requirements-completed: [INTEG-01]
completed: 2026-05-09
---

# Phase 04 Plan 02: OAuth Token Storage Summary

Plan 02 is complete. The planned `053` migration slot was already occupied in current `origin/main`, so this landed as the next available migration: `060_user_oauth_tokens.sql`.

## Migration

`supabase/migrations/060_user_oauth_tokens.sql` creates:

- `public.user_oauth_tokens`
  - PK: `(user_id, provider, token_type)`
  - `provider` check: `slack | google`
  - `token_type` check: `user | bot`
  - encrypted access/refresh token bytea columns
  - `scopes`, `external_account_id`, expiry, and timestamps
- RLS:
  - authenticated users can select only their own rows
  - writes are intentionally service-role only
- Service-role RPCs:
  - `public.get_oauth_token(uuid, text, text, text)`
  - `public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text)`
  - `public.delete_oauth_tokens(uuid, text)`
- `reset_tenant_tables()` now truncates `public.user_oauth_tokens`.

The migration uses `pgp_sym_encrypt(text, key)` and `pgp_sym_decrypt(bytea, key)` only. It does not use the `_bytea` variants.
The encryption/decryption helper functions include `extensions` in their pinned `search_path`, because Supabase installs `pgcrypto` outside `public` in the hosted projects.

## Public API

`src/lib/integrations/tokens/oauth-secret.ts`

- `new OAuthSecret(value)`
- `reveal(): string`
- `toJSON(): "[REDACTED]"`
- `toString(): "[REDACTED]"`
- `_value` is non-enumerable.

`src/lib/integrations/tokens/store.ts`

- `getDecryptedToken({ userId, provider, tokenType })`
- `upsertOAuthToken(input)`
- `deleteOAuthTokens({ userId, provider })`
- re-exports `OAuthSecret`
- exports `OauthProvider`, `OauthTokenType`, `DecryptedOAuthToken`, and `UpsertOAuthTokenInput`

All helpers read `OAUTH_TOKEN_ENCRYPTION_KEY` and throw `ConfigurationError` when it is missing. RPC errors throw `DatabaseError`. The store does not log plaintext token values.

## Tests

- `src/lib/integrations/tokens/oauth-secret.test.ts`
  - redaction, JSON safety, reveal, and non-enumerability.
- `src/lib/integrations/tokens/store.test.ts`
  - missing-key configuration error, null-row handling, `OAuthSecret` wrapping, RPC args, and `DatabaseError` handling.
- `src/lib/integrations/tokens/store.integration.test.ts`
  - round-trip decrypt, refresh-token COALESCE preservation, and cross-user RLS read denial.

The integration test is written but requires migration `060_user_oauth_tokens.sql` to be applied by CI before it can pass against the shared test database.

## Verification

- `npm run typecheck` passed.
- `npm test -- --run src/lib/integrations/tokens/oauth-secret.test.ts src/lib/integrations/tokens/store.test.ts` passed: 12 tests.
- SQL string checks passed for table, RLS, service-role RPCs, search path, pgcrypto text variants, grants, COALESCE refresh preservation, and reset helper inclusion.

## Next

Proceed to Plan 04-03: integration preferences and task integration columns.
