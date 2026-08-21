-- Sandra softphone Phase 1: simulated click-to-call data seam.
-- No telephony provider or Jitter call is introduced here.

alter table public.call_activities
  alter column property_id drop not null,
  alter column contact_id drop not null,
  add column if not exists direction text not null default 'outbound',
  add column if not exists phone_e164 text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'call_activities_direction_check'
      and conrelid = 'public.call_activities'::regclass
  ) then
    alter table public.call_activities
      add constraint call_activities_direction_check
      check (direction in ('outbound', 'inbound'));
  end if;
end;
$$;

create index if not exists call_activities_operator_started_idx
  on public.call_activities (operator_user_id, started_at desc nulls last);
