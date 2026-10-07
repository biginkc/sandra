-- 20261008143000_pipeline_runs.sql
-- Messages v2 evidence layer: one pipeline_runs row per inbound SMS, with
-- ordered pipeline_run_steps recording every gate, Jev judgment, threshold
-- decision, applied action, reply and hold. Observation only: server writers
-- (service_role) record what the pipeline already decided; browsers read
-- same-org rows and receive them over supabase_realtime.

begin;

create table if not exists public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  inbound_message_id uuid not null unique references public.messages(id) on delete cascade,
  property_id uuid,
  contact_id uuid,
  conversation_id uuid,
  status text not null default 'running',
  mode text not null default 'legacy',
  final_outcome text,
  reason text,
  classification_run_id uuid,
  claim_id uuid,
  outbound_message_id uuid,
  inbound_preview text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint pipeline_runs_status_check
    check (status in ('running', 'replied', 'held', 'escalated', 'closed', 'skipped', 'error')),
  constraint pipeline_runs_mode_check
    check (mode in ('shadow', 'automatic', 'legacy')),
  constraint pipeline_runs_inbound_preview_length_check
    check (inbound_preview is null or char_length(inbound_preview) <= 160)
);

comment on table public.pipeline_runs is
  'One row per inbound SMS handled by the messaging pipeline. Server-written evidence only; never drives decisions.';
comment on column public.pipeline_runs.inbound_preview is
  'First 160 characters of the seller text, for the feed card only.';

create table if not exists public.pipeline_run_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  seq int not null,
  kind text not null,
  name text not null,
  result text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint pipeline_run_steps_run_seq_key unique (run_id, seq),
  constraint pipeline_run_steps_kind_check
    check (kind in ('gate', 'jev', 'threshold', 'action', 'reply', 'hold', 'shadow')),
  constraint pipeline_run_steps_result_check
    check (result in ('pass', 'block', 'applied', 'held', 'sent', 'would_apply', 'error', 'skipped'))
);

comment on column public.pipeline_run_steps.detail is
  'Small enums, numbers and ids only. Seller message bodies and phone numbers never belong here.';

create index if not exists idx_pipeline_runs_org_started
  on public.pipeline_runs (org_id, started_at desc);
create index if not exists idx_pipeline_run_steps_run_seq
  on public.pipeline_run_steps (run_id, seq);

alter table public.pipeline_runs enable row level security;
alter table public.pipeline_run_steps enable row level security;

drop policy if exists pipeline_runs_org_select on public.pipeline_runs;
create policy pipeline_runs_org_select on public.pipeline_runs
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

drop policy if exists pipeline_run_steps_org_select on public.pipeline_run_steps;
create policy pipeline_run_steps_org_select on public.pipeline_run_steps
  for select to authenticated
  using (public.hugo_has_active_org_access(org_id));

revoke all on table public.pipeline_runs
  from public, anon, authenticated, service_role;
revoke all on table public.pipeline_run_steps
  from public, anon, authenticated, service_role;
grant select on table public.pipeline_runs to authenticated;
grant select on table public.pipeline_run_steps to authenticated;
grant select, insert, update on table public.pipeline_runs to service_role;
grant select, insert, update on table public.pipeline_run_steps to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'pipeline_runs'
  ) then
    execute 'alter publication supabase_realtime add table public.pipeline_runs';
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public'
      and tablename = 'pipeline_run_steps'
  ) then
    execute 'alter publication supabase_realtime add table public.pipeline_run_steps';
  end if;
end $$;

commit;
