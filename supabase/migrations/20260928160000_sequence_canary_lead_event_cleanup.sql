-- The service role can append lead_events but cannot delete ledger rows.
-- Allow only cleanup of a property tied to a sequence created by the dedicated
-- canary user and carrying the exact paired canary tags.
create or replace function public.delete_sequence_canary_lead_events(
  p_sequence_id uuid,
  p_property_id uuid,
  p_canary_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_count integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select s.org_id into v_org_id
  from public.sequences s
  join public.properties p on p.org_id = s.org_id
  where s.id = p_sequence_id
    and s.created_by = p_canary_user_id
    and s.name like 'SMOKE TEST — safe to delete %'
    and p.id = p_property_id
    and p.address = 'E2E PROD SMOKE ' || substring(s.name from length('SMOKE TEST — safe to delete ') + 1);
  if v_org_id is null then
    raise exception 'Refusing to clean non-canary lead events' using errcode = '42501';
  end if;

  delete from public.lead_events
  where org_id = v_org_id and property_id = p_property_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.delete_sequence_canary_lead_events(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.delete_sequence_canary_lead_events(uuid, uuid, uuid) to service_role;
