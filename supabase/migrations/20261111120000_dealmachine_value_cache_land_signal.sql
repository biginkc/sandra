-- 20261111120000_dealmachine_value_cache_land_signal.sql
-- Routing v2 price check: remember whether DealMachine's record looks like land
-- (Jarrad 2026-11-11: a land seller who names a price goes straight to him, tagged
-- vacant lot; DealMachine land values are unreliable, so no 80% check).
--
-- The signal comes from the SAME enrichment call that returns estimated_value
-- (living_area_sqft + num_bedrooms are requested alongside it; no extra call).
-- Additive only: nullable columns, existing rows stay NULL = unknown = today's
-- behaviour (no re-lookup, no re-bill).
--
-- Written by a separate RPC so the existing claim/settle signatures do not change:
-- old code keeps working before and after this migration, and new code tolerates
-- the RPC/columns being absent (treated as unknown).
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

alter table public.dealmachine_value_cache
  add column if not exists living_area_sqft numeric(14, 2),
  add column if not exists num_bedrooms numeric(6, 2),
  add column if not exists is_land boolean;

comment on column public.dealmachine_value_cache.is_land is
  'DealMachine record looks like land (living_area_sqft and num_bedrooms both 0/null). NULL = unknown (row cached before 20261111120000, or not recorded).';

-- Record the shape for the current claim holder only (matching token, still in_flight),
-- called right before settle. A stale claimer changes nothing.
create or replace function public.fn_dealmachine_value_record_shape(
  p_property_id uuid,
  p_claim_token uuid,
  p_living_area_sqft numeric,
  p_num_bedrooms numeric,
  p_is_land boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  update public.dealmachine_value_cache c
     set living_area_sqft = p_living_area_sqft,
         num_bedrooms = p_num_bedrooms,
         is_land = p_is_land,
         updated_at = now()
   where c.property_id = p_property_id
     and c.state = 'in_flight'
     and c.claim_token = p_claim_token;
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

revoke all on function public.fn_dealmachine_value_record_shape(uuid, uuid, numeric, numeric, boolean) from public, anon, authenticated;
grant execute on function public.fn_dealmachine_value_record_shape(uuid, uuid, numeric, numeric, boolean) to service_role;

commit;
