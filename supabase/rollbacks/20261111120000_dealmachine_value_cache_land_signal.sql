-- Rollback for 20261111120000_dealmachine_value_cache_land_signal.
-- Drops the land signal; the price check then treats every property as unknown (today's behaviour).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function if exists public.fn_dealmachine_value_record_shape(uuid, uuid, numeric, numeric, boolean);
alter table public.dealmachine_value_cache
  drop column if exists is_land,
  drop column if exists num_bedrooms,
  drop column if exists living_area_sqft;

commit;
