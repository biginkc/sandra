-- Rollback for 20261030370000. Refuses while any lead is still test-tagged (clean up the run first).
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from public.properties where test_run_id is not null) then
    raise exception 'test-tagged leads exist; clean up the test run before rolling back';
  end if;
end $$;
drop table if exists public.test_send_refusals;
drop trigger if exists trg_routing_v2_outbox_inherit_test_run on public.routing_v2_outbox;
drop function if exists public.routing_v2_outbox_inherit_test_run();
alter table public.routing_v2_outbox drop column if exists test_run_id;
drop index if exists public.properties_test_run_id_idx;
alter table public.properties drop column if exists test_run_id;
commit;
