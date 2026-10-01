-- Repository-wide sequence canary controls. No default rows: missing means stopped.
create table if not exists public.sequence_canary_controls (
  key text primary key check (key in (
    'SEQUENCE_CANARY_SCHEDULE_ENABLED',
    'SEQUENCE_CANARY_FAILURE_ACK_RUN_ID',
    'SEQUENCE_CANARY_MANUAL_RUN_ID'
  )),
  value text not null,
  changed_by text not null check (length(btrim(changed_by)) > 0),
  changed_at timestamptz not null default now()
);

alter table public.sequence_canary_controls enable row level security;
revoke all on public.sequence_canary_controls from public, anon, authenticated;
revoke all on public.sequence_canary_controls from service_role;
grant select on public.sequence_canary_controls to service_role;

-- The only application credential that may write controls is service_role.
-- Operators supply their identity; each update stamps the database clock.
create or replace function public.set_sequence_canary_control(
  p_key text, p_value text, p_actor text
) returns void
language plpgsql security definer
set search_path = ''
as $$
begin
  if p_key not in (
    'SEQUENCE_CANARY_SCHEDULE_ENABLED',
    'SEQUENCE_CANARY_FAILURE_ACK_RUN_ID',
    'SEQUENCE_CANARY_MANUAL_RUN_ID'
  ) or p_key is null or p_value is null or p_actor is null or btrim(p_actor) = '' then
    raise exception 'Invalid sequence canary control';
  end if;
  if p_key = 'SEQUENCE_CANARY_SCHEDULE_ENABLED' and p_value not in ('true', 'false') then
    raise exception 'Invalid sequence canary schedule flag';
  end if;
  if p_key = 'SEQUENCE_CANARY_MANUAL_RUN_ID' and p_value !~ '^[0-9]*$' then
    raise exception 'Invalid sequence canary manual run ID';
  end if;
  insert into public.sequence_canary_controls (key, value, changed_by, changed_at)
  values (p_key, p_value, p_actor, now())
  on conflict (key) do update
    set value = excluded.value, changed_by = excluded.changed_by, changed_at = now();
end;
$$;
revoke all on function public.set_sequence_canary_control(text, text, text) from public, anon, authenticated;
grant execute on function public.set_sequence_canary_control(text, text, text) to service_role;
