# Sandra Hugo cutover runbook

Sandra keeps its existing password login while `NEXT_PUBLIC_HUGO_SSO` is not
`1`. A deployment built with the flag set shows only **Sign in with Hugo** and
rejects password sessions on protected routes.

## Preflight

1. Confirm the production deployment points at the production Supabase project.
2. Confirm the Supabase Site URL is `https://sandra.bmhgroupkc.com`.
3. Allow both `https://sandra.bmhgroupkc.com/auth/callback` and the exact
   preview callback used for acceptance. Supabase requires `redirectTo` to
   match the redirect allowlist.
4. Confirm the existing `custom:hugo` provider has the correct Hugo issuer and
   client, uses PKCE, and remains disabled.
5. Confirm each intended teammate already has a Sandra membership using the
   same exact email as Hugo. Granting access must preserve any existing Auth UID
   and membership role.
6. Verify the password rollback deployment and record its deployment ID.

## Release order

1. Add `NEXT_PUBLIC_HUGO_SSO=1` to the target deployment environment.
2. Deploy the reviewed commit. Do not enable the provider yet.
3. Verify health, `/login`, and `/auth/hugo`; the login must show only **Sign in
   with Hugo**, and the launcher should fail closed while the provider is off.
4. Enable `custom:hugo` last.
5. In real Chrome, complete Hugo login and verify the same Sandra UID,
   membership role, and CRM data remain. Reload the dashboard and inspect the
   browser console. Repeat at desktop and mobile widths.
6. Treat password-injected Playwright sessions as support evidence only; they
   do not satisfy Hugo acceptance.

## Rollback

1. Disable `custom:hugo` first.
2. remove `NEXT_PUBLIC_HUGO_SSO` from the deployment environment.
3. redeploy the recorded password-login build, or deploy the reviewed build
   with the flag unset.
4. Verify `/login` exposes email and password again and `/auth/hugo` fails
   closed. Do not delete Auth users, identities, memberships, or CRM records.

## Legacy sessions

The app rejects non-Hugo sessions on protected routes while the flag is on and
explicitly expires their cookies. After successful acceptance, disable the
Supabase email provider and revoke legacy refresh sessions only after every
active teammate has confirmed Hugo access. Existing JWTs may remain valid until
their configured expiry, so keep the application-side provider check in place.
