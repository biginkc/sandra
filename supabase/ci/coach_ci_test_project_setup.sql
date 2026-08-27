-- ============================================================================
-- Coach realtime-authorization CI test fixtures — TEST PROJECT ONLY.
-- Applied 2026-08-27 directly to sandra-crm-test (ncsngxlcyxylaeskiteu) via
-- the Supabase MCP apply_migration/execute_sql tools, NOT via `supabase db
-- push`. This file is a REFERENCE COPY of what was applied, for audit and
-- reproducibility — it deliberately lives outside supabase/migrations/ so
-- neither db-migrate-test.yml nor db-migrate-prod.yml ever apply it. These
-- fixtures (two auth users, two RPCs) have no reason to exist anywhere
-- near production; keeping this file out of supabase/migrations/ is what
-- guarantees that.
--
-- Round-8 CI security review: two prior rounds hardened this workflow's
-- privilege ISOLATION (step-scoped env vars, then materializing reviewed
-- SQL outside the PR's own checkout). The final review correctly called
-- that fight unwinnable — a PR-controlled process (npm ci, the test file
-- itself) runs on the same runner, in the same process tree, as any
-- privileged step, so no amount of file/env scoping makes true isolation
-- real. The fix here is different: make the credential worthless instead
-- of trying to isolate it. See .github/workflows/coach-realtime-
-- authorization.yml for how these fixtures are actually used.
--
-- Design: two PERMANENT auth users, each capable of exactly one thing —
-- calling coach_ci_seed_ownership / coach_ci_delete_own_ownership to
-- seed/delete their OWN row in public.coach_call_index. Both functions
-- check auth.uid() against exactly these two accounts server-side; no
-- caller (including a real Sandra user, and — after the anon-grant
-- revokes below — even the unauthenticated `anon` role at the Postgres
-- grant level) can act as anyone else. If a PR-controlled process on the
-- CI runner does anything at all with these two accounts' credentials,
-- the worst case is "touch one row it already owns" — nothing worth
-- protecting against in the first place.
--
-- Passwords are NOT recorded here — they were generated locally, applied
-- via a plain UPDATE immediately after this script ran, and stored ONLY
-- as the coach-realtime-authorization GitHub Environment secrets
-- COACH_CI_OWNER_PASSWORD / COACH_CI_FOREIGN_PASSWORD. The placeholder
-- crypt() calls below use random bytes so no real credential is ever
-- recorded in Supabase's migration history either.
--
-- An earlier attempt used a dedicated Postgres role (`coach_ci_tester`,
-- narrow GRANTs on coach_call_index) reachable via a normal psql
-- connection instead of RPCs. That's infeasible on Supabase's hosted
-- platform: the shared Supavisor pooler (required for GitHub Actions,
-- which is IPv4-only) does not recognize custom roles created via raw
-- `create role` — confirmed empirically (a correct password against the
-- pooler's `<role>.<project-ref>` tenant format returns the same
-- generic "tenant/user not found" error a wrong password does, for both
-- the new role AND the well-known `postgres` role, ruling out a
-- propagation delay). PostgREST + RLS-equivalent RPCs sidestep this
-- entirely and are arguably a better fit anyway: no raw DB connection,
-- no pooler, no DB password at all — only the same anon-key + user-JWT
-- path the real production app already uses for everything else.
-- ============================================================================

begin;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data, is_super_admin,
  confirmation_token, recovery_token, email_change_token_new, email_change
) values
  (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(), 'authenticated', 'authenticated',
    'coach-ci-owner@bmhgroupkc.com',
    crypt(encode(gen_random_bytes(24), 'hex'), gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false,
    '', '', '', ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    gen_random_uuid(), 'authenticated', 'authenticated',
    'coach-ci-foreign@bmhgroupkc.com',
    crypt(encode(gen_random_bytes(24), 'hex'), gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, false,
    '', '', '', ''
  );

insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select
  gen_random_uuid(), u.id::text, u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email),
  'email', now(), now(), now()
from auth.users u
where u.email in ('coach-ci-owner@bmhgroupkc.com', 'coach-ci-foreign@bmhgroupkc.com');

create or replace function public.coach_ci_seed_ownership(p_call_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid()::text not in (
    (select id::text from auth.users where email = 'coach-ci-owner@bmhgroupkc.com'),
    (select id::text from auth.users where email = 'coach-ci-foreign@bmhgroupkc.com')
  ) then
    raise exception 'coach_ci_seed_ownership: not permitted for this user';
  end if;

  insert into public.coach_call_index (client_call_id, operator_user_id)
  values (p_call_id, auth.uid())
  on conflict (client_call_id) do update set operator_user_id = excluded.operator_user_id;
end;
$$;

create or replace function public.coach_ci_delete_own_ownership(p_call_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid()::text not in (
    (select id::text from auth.users where email = 'coach-ci-owner@bmhgroupkc.com'),
    (select id::text from auth.users where email = 'coach-ci-foreign@bmhgroupkc.com')
  ) then
    raise exception 'coach_ci_delete_own_ownership: not permitted for this user';
  end if;

  delete from public.coach_call_index
  where client_call_id = p_call_id
    and operator_user_id = auth.uid();
end;
$$;

-- Postgres grants EXECUTE on a new function to PUBLIC by default, which
-- both `anon` and `authenticated` inherit — revoke PUBLIC first, then
-- grant back only to `authenticated` (the two static users' own role once
-- signed in). `anon` is revoked explicitly too: the Supabase advisor
-- (anon_security_definer_function_executable) flagged that this project
-- grants some baseline EXECUTE to `anon` independent of PUBLIC, so
-- revoking PUBLIC alone left `anon` still able to reach the function at
-- the Postgres grant level — its call would still fail the auth.uid()
-- check inside, but there's no reason to rely on that as the only gate.
revoke all on function public.coach_ci_seed_ownership(text) from public;
revoke all on function public.coach_ci_delete_own_ownership(text) from public;
revoke all on function public.coach_ci_seed_ownership(text) from anon;
revoke all on function public.coach_ci_delete_own_ownership(text) from anon;
grant execute on function public.coach_ci_seed_ownership(text) to authenticated;
grant execute on function public.coach_ci_delete_own_ownership(text) to authenticated;

commit;
