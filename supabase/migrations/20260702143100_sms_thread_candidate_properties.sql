begin;

create or replace function public.sms_thread_candidate_properties(
  p_contact_id uuid,
  p_business_phone text default null
)
returns table (
  conversation_id uuid,
  property_id uuid,
  latest_at timestamptz
)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct on (m.property_id)
    m.conversation_id,
    m.property_id,
    m.created_at as latest_at
  from public.messages m
  join public.properties p
    on p.id = m.property_id
  where m.channel = 'sms'
    and m.contact_id = p_contact_id
    and m.property_id is not null
    and p.deleted_at is null
    and (
      nullif(trim(coalesce(p_business_phone, '')), '') is null
      or m.from_address = p_business_phone
      or m.to_address = p_business_phone
    )
  order by m.property_id, m.created_at desc, m.id desc;
$$;

revoke execute on function public.sms_thread_candidate_properties(uuid, text)
  from public;
grant execute on function public.sms_thread_candidate_properties(uuid, text)
  to authenticated;
grant execute on function public.sms_thread_candidate_properties(uuid, text)
  to service_role;

commit;
