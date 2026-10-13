-- 20261008250000_luna_suggestions.sql
-- Luna suggestions for /messages-v2 hold cards: one stored outcome suggestion per
-- inbound message, plus accept / reject / agreed-manually bookkeeping and a
-- read-only stats function. DB structure only: no classification rules live here.
--
-- luna_suggestions
--   * one row per inbound message (inbound_message_id is unique).
--   * identity columns (org, property, message, outcome, confidence, model,
--     created_at) are immutable; once accepted or rejected the row is frozen;
--     applied_outcome, once set, never changes.
--   * authenticated: read-only (owner or acquisitions member, same gate as the
--     other pipeline tables). service_role: select / insert / update. Nobody deletes.
-- fn_luna_suggestion_stats: SECURITY INVOKER read-only counts per outcome over a
--   trailing 7 or 30 day window.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.luna_suggestions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null,
  inbound_message_id uuid not null unique references public.messages(id) on delete cascade,
  outcome text not null,
  confidence numeric(5,4) not null,
  model text not null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id),
  rejected_at timestamptz,
  rejected_by uuid references auth.users(id),
  applied_outcome text,
  constraint luna_suggestions_property_fk
    foreign key (property_id, org_id) references public.properties(id, org_id) on delete cascade,
  constraint luna_suggestions_outcome_check
    check (outcome in ('new_lead','nurture','not_interested','wrong_number','bad_number','opted_out','dnc','unclear')),
  constraint luna_suggestions_applied_outcome_check
    check (applied_outcome is null or applied_outcome in ('new_lead','nurture','not_interested','wrong_number','bad_number','opted_out','dnc','unclear')),
  constraint luna_suggestions_confidence_check
    check (confidence >= 0 and confidence <= 1),
  constraint luna_suggestions_not_both_check
    check (not (accepted_at is not null and rejected_at is not null)),
  constraint luna_suggestions_accepted_pair_check
    check ((accepted_at is null) = (accepted_by is null)),
  constraint luna_suggestions_rejected_pair_check
    check ((rejected_at is null) = (rejected_by is null)),
  constraint luna_suggestions_accepted_applied_check
    check (accepted_at is null or coalesce(applied_outcome = outcome, false)),
  constraint luna_suggestions_open_applied_check
    check (accepted_at is not null or rejected_at is not null or applied_outcome is null or applied_outcome = outcome)
);

comment on table public.luna_suggestions is
  'One Luna outcome suggestion per inbound message, with accept / reject / agreed-manually bookkeeping. Write: service role only. Read: owner or acquisitions members.';

create index if not exists idx_luna_suggestions_org_created
  on public.luna_suggestions (org_id, created_at desc);

-- Immutability ---------------------------------------------------------------
create or replace function public.luna_suggestions_guard_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.org_id is distinct from old.org_id
     or new.property_id is distinct from old.property_id
     or new.inbound_message_id is distinct from old.inbound_message_id
     or new.outcome is distinct from old.outcome
     or new.confidence is distinct from old.confidence
     or new.model is distinct from old.model
     or new.created_at is distinct from old.created_at then
    raise exception 'luna_suggestions identity columns are immutable' using errcode = '23514';
  end if;

  if (old.accepted_at is not null or old.rejected_at is not null)
     and (new.accepted_at is distinct from old.accepted_at
          or new.accepted_by is distinct from old.accepted_by
          or new.rejected_at is distinct from old.rejected_at
          or new.rejected_by is distinct from old.rejected_by
          or new.applied_outcome is distinct from old.applied_outcome) then
    raise exception 'luna_suggestions row is already decided' using errcode = '23514';
  end if;

  if old.applied_outcome is not null and new.applied_outcome is distinct from old.applied_outcome then
    raise exception 'luna_suggestions.applied_outcome cannot change once set' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.luna_suggestions_guard_update() from public, anon, authenticated;

drop trigger if exists trg_luna_suggestions_guard_update on public.luna_suggestions;
create trigger trg_luna_suggestions_guard_update
  before update on public.luna_suggestions
  for each row execute function public.luna_suggestions_guard_update();

-- Access ----------------------------------------------------------------------
alter table public.luna_suggestions enable row level security;
drop policy if exists luna_suggestions_org_select on public.luna_suggestions;
create policy luna_suggestions_org_select on public.luna_suggestions
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

revoke all on table public.luna_suggestions from public, anon, authenticated, service_role;
grant select on table public.luna_suggestions to authenticated;
grant select, insert, update on table public.luna_suggestions to service_role;

-- Stats -------------------------------------------------------------------------
create or replace function public.fn_luna_suggestion_stats(
  p_org_id uuid,
  p_window_days integer
)
returns table (
  outcome text,
  shown bigint,
  accepted bigint,
  rejected bigint,
  agreed_manually bigint,
  open bigint
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if p_window_days is null or p_window_days not in (7, 30) then
    raise exception 'p_window_days must be 7 or 30' using errcode = '22023';
  end if;

  return query
  select s.outcome,
         count(*)::bigint,
         (count(*) filter (where s.accepted_at is not null))::bigint,
         (count(*) filter (where s.rejected_at is not null))::bigint,
         (count(*) filter (where s.accepted_at is null and s.rejected_at is null
                             and s.applied_outcome is not null))::bigint,
         (count(*) filter (where s.accepted_at is null and s.rejected_at is null
                             and s.applied_outcome is null))::bigint
  from public.luna_suggestions s
  where s.org_id = p_org_id
    and s.created_at >= now() - make_interval(days => p_window_days)
    and s.outcome in ('new_lead','nurture','not_interested','wrong_number','opted_out','dnc')
  group by s.outcome
  order by s.outcome;
end;
$$;

comment on function public.fn_luna_suggestion_stats(uuid, integer) is
  'Luna suggestion stats per displayable outcome over a trailing 7 or 30 day window: shown / accepted / rejected / agreed_manually / open. SECURITY INVOKER read-only.';

revoke all on function public.fn_luna_suggestion_stats(uuid, integer) from public, anon;
grant execute on function public.fn_luna_suggestion_stats(uuid, integer) to authenticated, service_role;

-- Test reset helper must clear the new table too.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  if position('public.luna_suggestions' in v_def) > 0 then return; end if;
  v_new := replace(v_def, E'    public.hold_alert_settings,', E'    public.hold_alert_settings,\n    public.luna_suggestions,');
  if v_new = v_def then raise exception 'reset_tenant_tables luna-suggestions patch not applied'; end if;
  execute v_new;
end $$;

commit;
