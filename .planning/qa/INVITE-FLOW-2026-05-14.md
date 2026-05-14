# Invite Flow QA - 2026-05-14

## Issue

- URL: `/admin/users` invite action and `/auth/callback`
- Flow step: Admin sends Supabase invite, recipient opens invite email
- Expected: Recipient lands in Sandra, session is established, then they set a password
- Actual: The action generated `/auth/callback?type=invite`, but Supabase admin invites are implicit-flow links, not PKCE callbacks. The server callback could not read fragment tokens and only handled `?code=`.

## Fix

- Send admin invite links to `/auth/accept-invite`.
- Add a browser handoff route that reads `access_token` and `refresh_token` from the URL fragment, stores them via Supabase SSR cookie storage, validates the domain, and redirects to `/auth/set-password`.
- Keep `/auth/callback` compatible with token-hash email templates via `verifyOtp`.
- Upsert membership rows on `(user_id, org_id)` so retries/resends are idempotent.

## Retest

- `npm run verify`: passed.
- Browser sanity: `http://127.0.0.1:3000/auth/accept-invite#type=invite` redirected to `/login?error=invite_failed` and showed the invite error banner without console errors.
