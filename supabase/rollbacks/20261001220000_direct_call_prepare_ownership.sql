-- Rollback for 20261001220000_direct_call_prepare_ownership.sql.
-- Use immediately before the duration migration and whole-feature rollback, only with direct calling
-- disabled/drained and a coordinated app/schema change. This does not restore the historical 7-argument
-- begin RPC or baseline app behavior by itself.

begin;

drop function if exists public.direct_call_begin(uuid, uuid, uuid, uuid, text, text, uuid, integer, uuid);
drop function if exists public.direct_call_set_target(uuid, uuid, uuid, text);
alter table if exists public.direct_calls drop column if exists preparation_property_id;

commit;
