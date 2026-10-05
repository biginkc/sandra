-- My Leads one-call close, P1e (1e.1): housekeeping run ledger and before-image store.
--
-- Schema only. NO data step: the merge of this file auto-applies to production, and
-- every real-data change runs later through scripts/my-leads-housekeeping.mjs after a
-- pasted preview is approved (docs/my-leads/TECH-PLAN-2026-10.md, "Data steps").
-- Both tables are closed to every API role (same posture as acquisition_attempts);
-- only the security definer fn_my_leads_housekeeping_* functions touch them.
begin;

create table public.my_leads_housekeeping_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in (
    'reassign', 'close_attempts', 'relabel', 'offer_follow_up_backfill',
    'link_backfill', 'phone_backfill', 'ack_legacy_prompts'
  )),
  status text not null default 'applied' check (status in ('applied', 'rolled_back')),
  params jsonb not null default '{}'::jsonb,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz
);

create table public.my_leads_housekeeping_before_images (
  run_id uuid not null references public.my_leads_housekeeping_runs(id) on delete cascade,
  table_name text not null check (table_name in (
    'properties', 'acquisition_assignment_episodes', 'tasks', 'acquisition_attempts',
    'acquisition_offers', 'acquisition_appointment_attribution', 'call_activities',
    'contact_phone_numbers'
  )),
  row_id uuid not null,
  before jsonb not null,
  primary key (run_id, table_name, row_id)
);

create index my_leads_housekeeping_runs_org_created_idx
  on public.my_leads_housekeeping_runs (org_id, created_at desc);

alter table public.my_leads_housekeeping_runs enable row level security;
alter table public.my_leads_housekeeping_before_images enable row level security;
revoke all on public.my_leads_housekeeping_runs, public.my_leads_housekeeping_before_images
  from public, anon, authenticated, service_role;

-- Service-only gate used by every housekeeping function (same check as the jitter/norma RPCs).
create or replace function public.my_leads_housekeeping_require_service() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
end $$;
revoke all on function public.my_leads_housekeeping_require_service()
  from public, anon, authenticated, service_role;

commit;
