-- Rollback for 20261031131400. Refuses while not_routed audit rows exist (evidence is append-only).
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.routing_v2_live_decisions where status = 'not_routed') then
    raise exception 'routing v2 not_routed audit rows exist; keep them and disable flags instead';
  end if;
end $$;
alter table public.routing_v2_live_decisions drop constraint if exists routing_v2_live_decisions_status_check;
alter table public.routing_v2_live_decisions add constraint routing_v2_live_decisions_status_check
  check (status in ('decided', 'failed'));
commit;
