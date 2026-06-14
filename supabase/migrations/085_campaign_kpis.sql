begin;

create or replace function public.campaign_kpis(p_campaign_id uuid)
returns table (
  audience bigint,
  attempted bigint,
  delivered bigint,
  delivered_rate double precision,
  failed bigint,
  failed_rate double precision,
  replied bigint,
  reply_rate double precision,
  opted_out bigint,
  opt_out_rate double precision
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_caller_id uuid := auth.uid();
begin
  select c.org_id
  into v_org_id
  from public.campaigns c
  where c.id = p_campaign_id;

  if v_org_id is null then
    raise exception 'campaign_kpis: campaign % not found', p_campaign_id
      using errcode = 'P0002';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_caller_id is null then
      raise exception 'campaign_kpis: authenticated user required'
        using errcode = '28000';
    end if;

    if not exists (
      select 1
      from public.memberships m
      where m.user_id = v_caller_id
        and m.org_id = v_org_id
    ) then
      raise exception 'campaign_kpis: caller is not authorized for org %', v_org_id
        using errcode = '42501';
    end if;
  end if;

  return query
  with recipient_counts as (
    select count(*)::bigint as audience
    from public.campaign_recipients cr
    where cr.campaign_id = p_campaign_id
  ),
  outbound_messages as (
    select m.property_id, m.status
    from public.messages m
    where m.campaign_id = p_campaign_id
      and m.direction = 'outbound'
      and m.status in ('sent', 'delivered', 'failed')
  ),
  outbound_counts as (
    select
      count(distinct property_id)::bigint as attempted,
      count(distinct property_id) filter (where status = 'delivered')::bigint as delivered,
      count(distinct property_id) filter (where status = 'failed')::bigint as failed
    from outbound_messages
  ),
  attributed_inbound as (
    select
      inbound.contact_id,
      lower(coalesce(inbound.metadata->>'keyword', '')) as keyword
    from public.messages inbound
    join public.messages outbound
      on outbound.id = inbound.attributed_outbound_message_id
    where outbound.campaign_id = p_campaign_id
      and inbound.direction = 'inbound'
      and inbound.contact_id is not null
  ),
  inbound_counts as (
    select
      count(distinct contact_id) filter (where keyword <> 'stop')::bigint as replied,
      count(distinct contact_id) filter (where keyword = 'stop')::bigint as opted_out
    from attributed_inbound
  )
  select
    rc.audience,
    oc.attempted,
    oc.delivered,
    case
      when oc.attempted = 0 then 0
      else round((oc.delivered::numeric * 100.0) / oc.attempted::numeric, 1)::double precision
    end as delivered_rate,
    oc.failed,
    case
      when oc.attempted = 0 then 0
      else round((oc.failed::numeric * 100.0) / oc.attempted::numeric, 1)::double precision
    end as failed_rate,
    ic.replied,
    case
      when oc.attempted = 0 then 0
      else round((ic.replied::numeric * 100.0) / oc.attempted::numeric, 1)::double precision
    end as reply_rate,
    ic.opted_out,
    case
      when oc.attempted = 0 then 0
      else round((ic.opted_out::numeric * 100.0) / oc.attempted::numeric, 1)::double precision
    end as opt_out_rate
  from recipient_counts rc
  cross join outbound_counts oc
  cross join inbound_counts ic;
end;
$$;

revoke execute on function public.campaign_kpis(uuid) from public;
grant execute on function public.campaign_kpis(uuid) to authenticated;
grant execute on function public.campaign_kpis(uuid) to service_role;

commit;
