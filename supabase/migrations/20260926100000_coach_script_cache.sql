-- ============================================================================
-- Migration: coach script cache
-- Purpose: durable, immutable cache for revisions pulled from Closer Lab.
--
-- Sandra never owns or edits script content. A future service-role-only sync
-- writes validated snapshots here; live calls bind to one cached digest or
-- leave the binding null when no default is available. Nullable call columns
-- keep both deployment orders safe: dialing and realtime authorization do not
-- depend on the cache being populated.
-- ============================================================================

begin;

create table if not exists public.coach_script_revisions (
  digest text primary key check (digest ~ '^[0-9a-f]{64}$'),
  slug text not null check (length(slug) > 0),
  revision integer not null check (revision > 0),
  schema_version integer not null check (schema_version > 0),
  bundle jsonb not null,
  import_status text not null check (import_status in ('reviewed', 'unreviewed')),
  fetched_at timestamptz not null default now(),
  unique (slug, revision),
  unique (digest, slug),
  unique (digest, slug, revision)
);

comment on table public.coach_script_revisions is
  'Immutable, service-role-written cache of exact coach script revisions pulled from Closer Lab. Sandra validates and recomputes every digest before insertion; live calls bind by digest and never substitute another revision.';

create or replace function public.prevent_coach_script_revision_mutation()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'coach_script_revisions are immutable';
end;
$$;

drop trigger if exists coach_script_revisions_immutable on public.coach_script_revisions;
create trigger coach_script_revisions_immutable
  before update or delete on public.coach_script_revisions
  for each row execute function public.prevent_coach_script_revision_mutation();

alter table public.coach_script_revisions enable row level security;
revoke all on table public.coach_script_revisions from public, anon, authenticated;
grant select on table public.coach_script_revisions to authenticated;

drop policy if exists coach_script_revisions_authenticated_select on public.coach_script_revisions;
create policy coach_script_revisions_authenticated_select on public.coach_script_revisions
  for select
  to authenticated
  using (true);

create table if not exists public.coach_script_defaults (
  slug text primary key check (length(slug) > 0),
  digest text not null,
  updated_at timestamptz not null default now()
);

alter table public.coach_script_defaults
  add constraint coach_script_defaults_digest_slug_fkey
  foreign key (digest, slug)
  references public.coach_script_revisions(digest, slug)
  on delete restrict;

comment on table public.coach_script_defaults is
  'Service-role-managed current cached revision by script slug. Absence is an expected unavailable-script state, never a fallback signal.';

alter table public.coach_script_defaults enable row level security;
revoke all on table public.coach_script_defaults from public, anon, authenticated;

-- Defaults are an internal sync/binding concern. The browser receives a
-- call-bound revision through the later authenticated server action instead.

alter table public.coach_call_index
  add column if not exists script_slug text null,
  add column if not exists script_revision integer null,
  add column if not exists script_digest text null;

alter table public.coach_call_index
  add constraint coach_call_index_script_binding_fkey
  foreign key (script_digest, script_slug, script_revision)
  references public.coach_script_revisions(digest, slug, revision)
  match full
  on delete restrict;

comment on column public.coach_call_index.script_slug is
  'Cached script slug selected at call start; null means coaching is unavailable for this call.';
comment on column public.coach_call_index.script_revision is
  'Cached script revision selected at call start; null means coaching is unavailable for this call.';
comment on column public.coach_call_index.script_digest is
  'Exact immutable cached script digest selected at call start; null means coaching is unavailable for this call.';

commit;
