-- The hosted Slack canary must be able to prove that no provider work exists
-- without granting the worker table access to the SMS delivery ledger. Keep
-- this RPC boolean-only: callers receive no row, token, phone, or provider
-- metadata.
create or replace function public.get_slack_canary_provider_safety(
  p_org_id uuid,
  p_property_id uuid,
  p_contact_id uuid,
  p_run_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_org_id is null or p_property_id is null or p_contact_id is null or p_run_id is null then
    return false;
  end if;

  if not exists (
    select 1
      from public.properties p
      join public.contacts c
        on c.id = p.homeowner_contact_id
       and c.org_id = p.org_id
     where p.id = p_property_id
       and p.org_id = p_org_id
       and p.homeowner_contact_id = p_contact_id
       and p.deleted_at is null
       and p.notes = 'SLACK PREVIEW CANARY ' || p_run_id::text || '; synthetic only; no seller contact'
       and c.id = p_contact_id
       and c.notes = 'SLACK PREVIEW CANARY ' || p_run_id::text || '; synthetic only; no phone; no outreach'
       and nullif(btrim(c.phone_1), '') is null
       and nullif(btrim(c.phone_2), '') is null
       and nullif(btrim(c.phone_3), '') is null
  ) then
    return false;
  end if;

  if exists (
    select 1 from public.rep_sms_obligations o
     where o.org_id = p_org_id and o.property_id = p_property_id
  ) then
    return false;
  end if;
  if exists (
    select 1 from public.rep_sms_delivery_ledger l
     where l.org_id = p_org_id
       and (l.property_id = p_property_id or l.contact_id = p_contact_id)
  ) then
    return false;
  end if;
  if exists (
    select 1 from public.dialpad_call_intents i
     where i.org_id = p_org_id
       and (i.property_id = p_property_id or i.contact_id = p_contact_id)
  ) then
    return false;
  end if;

  return true;
exception when others then
  -- An unavailable relation, unexpected schema, or other read failure must
  -- never make an ambiguous fixture eligible for the provider path.
  return false;
end;
$$;

revoke all on function public.get_slack_canary_provider_safety(uuid,uuid,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.get_slack_canary_provider_safety(uuid,uuid,uuid,uuid)
  to service_role;
