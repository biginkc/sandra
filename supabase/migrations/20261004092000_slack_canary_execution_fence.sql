-- Replace the externally supplied claim token with a server-generated token
-- before the canary enters the unchanged worker. This exact-job CAS prevents
-- two requests carrying the same original token from dispatching together.
create or replace function public.claim_slack_canary_execution(
  p_job_id uuid,
  p_claim_token uuid,
  p_private_claim_token uuid,
  p_org_id uuid,
  p_property_id uuid,
  p_run_id uuid,
  p_canonical_url text
) returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_contact_id uuid;
  v_rows integer;
begin
  if p_job_id is null or p_claim_token is null or p_private_claim_token is null
     or p_claim_token = p_private_claim_token or p_org_id is null
     or p_property_id is null or p_run_id is null or p_canonical_url is null then
    return false;
  end if;

  select p.homeowner_contact_id into v_contact_id
    from public.properties p
   where p.id = p_property_id
     and p.org_id = p_org_id
     and p.deleted_at is null
     and p.notes = 'SLACK PREVIEW CANARY ' || p_run_id::text || '; synthetic only; no seller contact';
  if not found or v_contact_id is null then return false; end if;

  if not public.get_slack_canary_provider_safety(p_org_id, p_property_id, v_contact_id, p_run_id) then
    return false;
  end if;

  if (
    select count(*)
      from public.messages m
     where m.org_id = p_org_id
       and m.channel = 'sms'
       and (
         m.property_id = p_property_id
         or (m.property_id is null and m.contact_id = v_contact_id)
       )
       and m.metadata->>'canaryRunId' = p_run_id::text
  ) <> 3 then
    return false;
  end if;

  if exists (
    select 1
      from public.messages m
     where m.org_id = p_org_id
       and m.channel = 'sms'
       and (
         m.property_id = p_property_id
         or (m.property_id is null and m.contact_id = v_contact_id)
       )
       and (
         m.metadata is null
         or m.metadata->>'canaryRunId' is distinct from p_run_id::text
         or not (
           (m.property_id = p_property_id and (m.contact_id is null or m.contact_id = v_contact_id))
           or (m.property_id is null and m.contact_id = v_contact_id)
         )
       )
  ) then
    return false;
  end if;

  if (
    select count(*) from public.slack_unfurl_job_urls u
     where u.job_id = p_job_id
  ) <> 1 then
    return false;
  end if;
  if not exists (
    select 1 from public.slack_unfurl_job_urls u
     where u.job_id = p_job_id and u.url_key = p_canonical_url
  ) then
    return false;
  end if;

  update public.slack_unfurl_jobs j
     set claim_token = p_private_claim_token,
         updated_at = statement_timestamp()
   where j.id = p_job_id
     and j.status = 'processing'
     and j.attempts = 1
     and j.claim_token = p_claim_token
     and j.org_id = p_org_id
     and j.lease_expires_at > statement_timestamp()
     and j.lease_expires_at <= statement_timestamp() + interval '120 seconds'
     and j.expires_at > statement_timestamp()
     and j.event_time + interval '15 minutes' > statement_timestamp();
  get diagnostics v_rows = row_count;
  return v_rows = 1;
exception when others then
  return false;
end;
$$;

revoke all on function public.claim_slack_canary_execution(uuid,uuid,uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_slack_canary_execution(uuid,uuid,uuid,uuid,uuid,uuid,text)
  to service_role;
