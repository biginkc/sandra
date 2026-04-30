-- Migration 034: SMS Templates
-- Creates the sms_templates table for storing reusable SMS message templates.

create table if not exists public.sms_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0 and length(name) <= 120),
  content     text not null check (length(trim(content)) > 0),
  category    text not null default 'General',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz  -- soft delete
);

-- Index for fast org-scoped queries and category filtering.
create index if not exists idx_sms_templates_org
  on public.sms_templates(org_id) where deleted_at is null;
create index if not exists idx_sms_templates_category
  on public.sms_templates(org_id, category) where deleted_at is null;

-- RLS: matches existing Sandra pattern — any authenticated user has full access.
-- TODO(multi-tenant): tighten to `using (org_id in (select org_id from
-- org_members where user_id = auth.uid()))` when the multi-org cutover lands.
-- Tracked in WR-01 of phase 01 review (2026-04-29). Every other table in this
-- repo follows the same `for all to authenticated using (true)` pattern, so
-- migrating sms_templates alone would be inconsistent — defer until the
-- coordinated multi-tenant migration. sms_templates is higher-leverage than
-- most (carries hand-written customer copy, referenced by sequences that
-- fire to specific contacts), so prioritize it within that batch.
alter table public.sms_templates enable row level security;
drop policy if exists sms_templates_authenticated_all on public.sms_templates;
create policy sms_templates_authenticated_all on public.sms_templates
  for all to authenticated using (true) with check (true);

-- Auto-update updated_at on modification (reuse existing function if available).
-- `set search_path = ''` pins lookups to fully-qualified names so a malicious
-- schema-shadowing attack can't hijack `now()` or any unqualified call inside
-- the trigger (Supabase hardening recommendation).
do $$
begin
  if not exists (
    select 1 from pg_proc where proname = 'set_updated_at'
  ) then
    create function public.set_updated_at()
    returns trigger
    language plpgsql
    set search_path = ''
    as $fn$
    begin
      new.updated_at = now();
      return new;
    end;
    $fn$;
  end if;
end;
$$;

drop trigger if exists trg_sms_templates_updated_at on public.sms_templates;
create trigger trg_sms_templates_updated_at
  before update on public.sms_templates
  for each row execute function public.set_updated_at();
