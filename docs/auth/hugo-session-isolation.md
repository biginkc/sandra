# Hugo session isolation

Sandra previously rechecked each session's OAuth AMR timestamp against the shared
Hugo identity's `updated_at` on every request. A sign-in in another browser changes
that identity, causing older valid sessions to fail the 60-second comparison.

The timestamp check now applies only to the nonce-bound PKCE callback. After
provider, domain, and membership checks succeed, the callback sets an HttpOnly,
SameSite=Lax, host-only proof cookie (`__Host-sandra-hugo-session` on HTTPS). Its
HMAC-SHA256 binds origin, issuer, user ID, session ID, and OAuth AMR timestamp.
It contains no access or refresh token. Only the server holds its signing key.

Middleware checks Supabase user/claims and the proof, then independently checks
current Sandra membership. A token refresh changes iat/exp but retains the session
and original OAuth AMR; a different login gets a different proof. Cookie copying
cannot authorize another account, session, provider exchange, project, or origin.
Account-wide identity timestamps are never consulted for an established session.
Sign-out clears the proof and uses Supabase's local session scope.

## Configuration and rollout

`HUGO_SESSION_PROOF_SECRET` must be a random 32-byte key encoded as 64 hex characters.
Use separate server-only secrets for production and preview; never prefix it with
NEXT_PUBLIC or commit its value. A missing/invalid key returns no-store HTTP 503
without exchanging/revoking sessions. Provision it before deploying the code.

Sessions created before this change need one new Hugo sign-in. Key rotation also
requires fresh sign-in. The cookie lasts 365 days, but grants no access by itself:
Supabase authentication and live membership remain required on every request.
No database migration is needed. Roll back the code via the normal Vercel release
flow; leave the secret in place for a retry. Rollback restores the old logout defect.

## Validation

- Unit and route tests cover callback proof issuance, missing key, session/issuer/
  user/origin mismatch, tampering, password denial, refresh, and access denial.
- `npx vitest run --config vitest.hugo-browser.config.ts` uses two independent
  headless Chrome contexts through the actual callback/server cookie adapter and
  middleware. The external Supabase API is simulated. It advances the shared
  identity at B's login, then verifies A, A's token refresh, B, copied-proof denial,
  and revoked membership denial. This is also run in E2E CI.
- Hosted OAuth acceptance must be checked separately against the deployed build.
  Establish A, wait more than 60 seconds, sign in to B in a separate browser profile,
  then reload A and B. Neither should redirect to login.
