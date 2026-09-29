begin;

create index acquisition_attempts_property_recorded_idx
  on public.acquisition_attempts (org_id, property_id, recorded_at desc);

-- The inbox must compare an attempt's recording time with the drip reply.
-- Authenticated clients cannot select directly from acquisition_attempts.
create function public.fn_has_acquisition_attempt_recorded_after(
  p_property_id uuid,
  p_after timestamptz
)
returns boolean language plpgsql stable security definer set search_path = ''
set statement_timeout = '5s' as $$
declare v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_property_id is null or p_after is null or not isfinite(p_after) then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select org_id into v_org from public.properties
    where id = p_property_id and deleted_at is null;
  if v_org is null or not coalesce(public.hugo_has_active_org_access(v_org), false) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  return exists (
    select 1 from public.acquisition_attempts
    where org_id = v_org and property_id = p_property_id and recorded_at > p_after
  );
end;
$$;

revoke all on function public.fn_has_acquisition_attempt_recorded_after(uuid, timestamptz)
  from public, anon, service_role;
grant execute on function public.fn_has_acquisition_attempt_recorded_after(uuid, timestamptz)
  to authenticated;

commit;
