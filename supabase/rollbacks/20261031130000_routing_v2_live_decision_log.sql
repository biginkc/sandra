-- Preserve any live evidence. Rollback flags first; never discard an executed decision.
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.routing_v2_live_decisions) then
    raise exception 'Live routing-v2 decisions exist; retain this audit table and disable flags instead';
  end if;
end $$;
drop table public.routing_v2_live_decisions;
commit;
