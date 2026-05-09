-- ============================================================================
-- Phase 04 — user_oauth_tokens
--
-- Per-user OAuth credentials for Slack + Google Calendar. Tokens are encrypted
-- at rest with pgcrypto pgp_sym_encrypt(text, key). The encryption key is
-- supplied by server-side callers as p_key and is never stored in pg_proc.
--
-- Composite PK (user_id, provider, token_type) supports Slack bot + user rows
-- and Google user rows without a second secret store.
--
-- CI-only: applies on PR merge via .github/workflows/db-migrate.yml.
-- ============================================================================

create table public.user_oauth_tokens (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('slack', 'google')),
  token_type text not null check (token_type in ('user', 'bot')),
  access_token_encrypted bytea not null,
  refresh_token_encrypted bytea,
  access_token_expires_at timestamptz,
  scopes text[] not null default '{}',
  external_account_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider, token_type)
);

comment on table public.user_oauth_tokens is
  'Per-user encrypted OAuth credentials for Slack + Google Calendar. Encrypted via pgcrypto pgp_sym_encrypt; key passed at decrypt time, never stored in pg_proc bodies.';

alter table public.user_oauth_tokens enable row level security;

create policy user_oauth_tokens_self_read on public.user_oauth_tokens
  for select
  to authenticated
  using (user_id = auth.uid());

-- INSERT/UPDATE/DELETE intentionally not granted to authenticated callers.
-- Writes go through service-role-only helper functions below.

create or replace function public.get_oauth_token(
  p_user_id uuid,
  p_provider text,
  p_token_type text,
  p_key text
)
returns table(
  access_token text,
  refresh_token text,
  access_token_expires_at timestamptz,
  scopes text[],
  external_account_id text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    pgp_sym_decrypt(access_token_encrypted, p_key) as access_token,
    case
      when refresh_token_encrypted is null then null
      else pgp_sym_decrypt(refresh_token_encrypted, p_key)
    end as refresh_token,
    access_token_expires_at,
    scopes,
    external_account_id
  from public.user_oauth_tokens
  where user_id = p_user_id
    and provider = p_provider
    and token_type = p_token_type;
$$;

revoke execute on function public.get_oauth_token(uuid, text, text, text) from public;
revoke execute on function public.get_oauth_token(uuid, text, text, text) from authenticated;
grant  execute on function public.get_oauth_token(uuid, text, text, text) to service_role;

create or replace function public.upsert_oauth_token(
  p_user_id uuid,
  p_provider text,
  p_token_type text,
  p_access text,
  p_refresh text,
  p_expires_at timestamptz,
  p_scopes text[],
  p_account text,
  p_key text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.user_oauth_tokens (
    user_id,
    provider,
    token_type,
    access_token_encrypted,
    refresh_token_encrypted,
    access_token_expires_at,
    scopes,
    external_account_id
  )
  values (
    p_user_id,
    p_provider,
    p_token_type,
    pgp_sym_encrypt(p_access, p_key),
    case when p_refresh is null then null else pgp_sym_encrypt(p_refresh, p_key) end,
    p_expires_at,
    coalesce(p_scopes, '{}'),
    p_account
  )
  on conflict (user_id, provider, token_type)
  do update set
    access_token_encrypted = excluded.access_token_encrypted,
    refresh_token_encrypted = coalesce(
      excluded.refresh_token_encrypted,
      user_oauth_tokens.refresh_token_encrypted
    ),
    access_token_expires_at = excluded.access_token_expires_at,
    scopes = excluded.scopes,
    external_account_id = excluded.external_account_id,
    updated_at = now();
$$;

revoke execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) from public;
revoke execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) from authenticated;
grant  execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) to service_role;

create or replace function public.delete_oauth_tokens(
  p_user_id uuid,
  p_provider text
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.user_oauth_tokens
  where user_id = p_user_id
    and provider = p_provider;
$$;

revoke execute on function public.delete_oauth_tokens(uuid, text) from public;
revoke execute on function public.delete_oauth_tokens(uuid, text) from authenticated;
grant  execute on function public.delete_oauth_tokens(uuid, text) to service_role;

create or replace function public.reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  create temp table _memberships_snapshot on commit drop as
    select * from public.memberships;

  truncate table
    public.user_oauth_tokens,
    public.call_recordings,
    public.call_transcripts,
    public.call_activities,
    public.dialer_batch_items,
    public.dialer_batches,
    public.metric_snapshots,
    public.memberships,
    public.tasks,
    public.job_items,
    public.messages,
    public.consent_events,
    public.property_merges,
    public.jobs,
    public.csv_imports,
    public.webhook_events,
    public.webhook_consumers,
    public.notifications,
    public.lead_notes,
    public.sequence_step_runs,
    public.sequence_enrollments,
    public.sequence_steps,
    public.sequences,
    public.ai_responder_configs,
    public.property_lists,
    public.property_tags,
    public.tags,
    public.test_sms_log,
    public.properties,
    public.homeowner_details,
    public.agent_details,
    public.contacts,
    public.cass_cache,
    public.skip_trace_cache
  restart identity cascade;

  delete from public.lists where coalesce(system_managed, false) = false;

  delete from public.sms_templates
  where coalesce(system_managed, false) = false
    and deleted_at is null;

  insert into public.memberships
  select * from _memberships_snapshot
  on conflict (user_id, org_id) do nothing;
end;
$$;

revoke execute on function public.reset_tenant_tables() from public;
revoke execute on function public.reset_tenant_tables() from authenticated;
