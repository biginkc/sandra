-- Rollback for 20261031130900: restore the 210000 / 250000 bodies byte for byte.
begin;
set local lock_timeout = '5s';
create or replace function public.fn_routing_v2_property_eligible(p_flags jsonb, p_property_id uuid)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb;
  v_pct jsonb;
  v_pct_num numeric;
begin
  if p_property_id is null or p_flags is null or jsonb_typeof(p_flags) <> 'object' then
    return false;
  end if;
  v_ids := p_flags -> 'canary_property_ids';
  v_pct := p_flags -> 'canary_percent';
  -- canary_property_ids: absent, or an array whose every entry is a UUID string.
  if v_ids is not null then
    if jsonb_typeof(v_ids) <> 'array' then
      return false;
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_ids) e
      where jsonb_typeof(e) <> 'string'
         or (e #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      return false;
    end if;
  end if;
  -- canary_percent: absent, or an integer 0..100.
  if v_pct is not null then
    if jsonb_typeof(v_pct) <> 'number' then
      return false;
    end if;
    v_pct_num := (v_pct #>> '{}')::numeric;
    if v_pct_num <> trunc(v_pct_num) or v_pct_num < 0 or v_pct_num > 100 then
      return false;
    end if;
  else
    v_pct_num := 0;
  end if;
  if v_ids is not null and exists (
    select 1 from jsonb_array_elements_text(v_ids) t where lower(t) = lower(p_property_id::text)
  ) then
    return true;
  end if;
  return public.fn_routing_v2_canary_bucket(p_property_id) < v_pct_num;
end;
$$;

create or replace function public.routing_v2_phone_action_eligible(p_flags jsonb, p_property_id uuid)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_ids jsonb := p_flags->'canary_property_ids';
  v_pct jsonb := p_flags->'canary_percent';
  v_percent numeric := 0;
  v_bucket bigint;
begin
  if p_flags is null or jsonb_typeof(p_flags) <> 'object' or p_property_id is null then
    return false;
  end if;
  if v_ids is not null then
    if jsonb_typeof(v_ids) <> 'array' then
      return false;
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_ids) e(v)
      where jsonb_typeof(e.v) <> 'string'
         or (e.v #>> '{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      return false;
    end if;
  end if;
  if v_pct is not null then
    if jsonb_typeof(v_pct) <> 'number' then
      return false;
    end if;
    v_percent := (v_pct #>> '{}')::numeric;
    if v_percent <> trunc(v_percent) or v_percent < 0 or v_percent > 100 then
      return false;
    end if;
  end if;
  if v_ids is not null and exists (
    select 1 from jsonb_array_elements_text(v_ids) e(v) where lower(e.v) = lower(p_property_id::text)
  ) then
    return true;
  end if;
  v_bucket := ('x' || substr(encode(sha256(convert_to(lower(p_property_id::text), 'UTF8')), 'hex'), 1, 8))::bit(32)::bigint % 100;
  return v_bucket < v_percent;
end;
$$;

revoke all on function public.fn_routing_v2_property_eligible(jsonb, uuid) from public, anon, authenticated;
grant execute on function public.fn_routing_v2_property_eligible(jsonb, uuid) to service_role;
revoke all on function public.routing_v2_phone_action_eligible(jsonb, uuid) from public, anon, authenticated;
commit;
