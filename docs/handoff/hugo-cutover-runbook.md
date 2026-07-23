# Sandra Hugo cutover runbook

Sandra keeps its existing password login while `NEXT_PUBLIC_HUGO_SSO` is not
`1`. A deployment built with the flag set shows only **Sign in with Hugo** and
rejects password sessions on protected routes.

## Preflight

1. Confirm the production deployment points at the production Supabase project.
2. Confirm the Supabase Site URL is `https://sandra.bmhgroupkc.com`.
3. Allow `https://sandra.bmhgroupkc.com/auth/callback` and an exact preview
   origin wildcard such as `https://<deployment-host>/**` for acceptance. The
   callback carries per-flow query parameters, so a bare preview callback URL
   does not match Supabase's redirect allowlist. Remove the preview entry after
   acceptance.
4. Confirm the existing `custom:hugo` provider has the correct Hugo issuer and
   client, uses PKCE, and remains disabled.
5. Confirm each intended teammate already has a Sandra membership using the
   same exact email as Hugo. Granting access must preserve any existing Auth UID
   and membership role.
6. Verify the password rollback deployment and record its deployment ID.

## Release order

1. Deploy the reviewed commit with `NEXT_PUBLIC_HUGO_SSO` unset. Verify health,
   password login, and password recovery before changing any provider.
2. Enable `custom:hugo`. This does not remove the working password fallback.
3. Add `NEXT_PUBLIC_HUGO_SSO=1` and deploy the reviewed commit. Verify `/login`
   now shows only **Sign in with Hugo** and `/auth/hugo` reaches Hugo.
4. In real Chrome, complete Hugo login and verify the same Sandra UID,
   membership role, and CRM data remain. Reload the dashboard and inspect the
   browser console. Repeat at desktop and mobile widths.
5. Capture a temporary, ignored Playwright storage-state file from that real
   Hugo session and run the production canaries with
   `PROD_HUGO_STORAGE_STATE=/absolute/path/to/state.json`. The storage state is
   a credential: never commit it or copy it into the vault.
6. Inventory every enabled Supabase authentication provider. After every active
   teammate has proved Hugo access, disable email/password and every provider
   except `custom:hugo`, then revoke legacy refresh sessions.
7. Prove a fresh password sign-in fails and a captured legacy refresh token can
   no longer mint an access token. Wait at least the configured access-token
   lifetime, then prove the old token cannot query a protected PostgREST table
   while a fresh Hugo token can. Only then describe Sandra as Hugo-only at the
   data boundary.

## Rollback

Before the provider shutdown in release step 6, remove `NEXT_PUBLIC_HUGO_SSO`,
deploy the reviewed flag-off build, verify a known password account and
recovery, then disable Hugo.

After provider shutdown, keep Hugo active while restoring email/password in
Supabase. Prove a fresh password sign-in and recovery email work, then deploy
the flag-off build and repeat the dashboard proof. Disable Hugo only after that
password rollback passes. Do not delete Auth users, identities, memberships, or
CRM records.

## Legacy sessions

The app rejects non-Hugo sessions on protected routes while the flag is on and
explicitly expires their cookies. Database RLS cannot distinguish the current
Hugo provider from another linked OAuth identity, so the operational email-auth
shutdown, refresh-session revocation, access-token expiry wait, and direct
PostgREST rejection proof are mandatory release gates rather than optional
cleanup.
