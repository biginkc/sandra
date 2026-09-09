-- D6: bypass the RLS evaluation barrier so search indexes are usable.
-- Explicit active membership and same-org references are the RPC security boundary.
set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.search_global(q text, per_type int default 5)
returns table (entity_type text, entity_id uuid, property_id uuid, conversation_id uuid, title text, subtitle text, matched_field text, rank real)
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  -- Plan for each query: SQL-function generic plans cannot simplify these gates.
  -- Values remain bound parameters, never interpolated into SQL.
  return query execute $search$
  -- Inline query inputs so index conditions retain the digit/structured guards.
  with visible_orgs as (
    select m.org_id from public.memberships m
    where m.user_id = auth.uid() and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
  ), bounds as not materialized (
    select left(btrim(coalesce($1,'')),100) as q,
      least(greatest(coalesce($2,5),1),10) as per_type
  ), normalized as not materialized (
    select bounds.*,
      regexp_replace(q,'[^0-9]','','g') as qd,
      replace(replace(replace(lower(q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      public.search_prefix_tsquery(q) as tsq
    from bounds where length(q) >= 3
  ), input as not materialized (
    select normalized.*,
      position('@' in q) > 0
        or (length(qd) >= 3 and 10 * length(qd) >= 7 * length(q)) as is_structured
    from normalized
  ), property_hits as (
    select 'property'::text as entity_type, p.id as entity_id, p.id as property_id,
      null::uuid as conversation_id, p.address as title,
      coalesce(p.city,'') || ' ' || coalesce(p.state,'') || ' ' || coalesce(p.zip,'') as subtitle,
      'address'::text as matched_field,
      (case when lower(p.address) like i.q_like || '%' escape E'\\' then 1 else 0 end + extensions.similarity(p.search_text,lower(i.q)))::real as rank
    from public.properties p cross join input i
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null and (
      p.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or (not i.is_structured and p.search_text OPERATOR(extensions.%) lower(i.q))
    )
    order by rank desc, p.updated_at desc, p.id desc
    limit (select per_type from bounds)
  ), contact_candidates as (
    select c.*, i.q, i.q_like, i.qd,
      (select p.id from public.properties p
       where p.org_id = c.org_id and p.org_id in (select org_id from visible_orgs)
         and (p.homeowner_contact_id = c.id or p.agent_contact_id = c.id) and p.deleted_at is null
       order by p.updated_at desc, p.id desc limit 1) as destination_property,
      (select m.conversation_id from public.messages m
       where m.org_id = c.org_id and m.org_id in (select org_id from visible_orgs)
         and m.contact_id = c.id and m.channel = 'sms' and m.conversation_id is not null
       order by m.created_at desc, m.id desc limit 1) as destination_conversation
    from public.contacts c cross join input i
    where c.org_id in (select org_id from visible_orgs) and (
      c.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or (not i.is_structured and c.search_text OPERATOR(extensions.%) lower(i.q))
      or (length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')
    )
  ), owner_hits as (
    select 'owner'::text as entity_type, c.id as entity_id,
      c.destination_property as property_id, c.destination_conversation as conversation_id,
      coalesce(nullif(btrim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')),''), nullif(c.entity_name,''), c.phone_1, c.email, 'Owner') as title,
      coalesce(c.email, c.phone_1, '') as subtitle,
      case when length(c.qd) >= 3 and c.phone_digits ilike '%' || c.qd || '%' then 'phone'
        when c.email ilike '%' || c.q_like || '%' escape E'\\' then 'email' else 'name' end as matched_field,
      extensions.similarity(c.search_text,lower(c.q)) as rank
    from contact_candidates c
    where c.destination_property is not null or c.destination_conversation is not null
    order by rank desc, c.created_at desc, c.id desc
    limit (select per_type from bounds)
  ), matching_messages as (
    select distinct on (m.conversation_id) m.*, ts_rank_cd(m.fts,i.tsq) as rank
    from public.messages m cross join input i
    where m.org_id in (select org_id from visible_orgs) and i.tsq is not null and m.channel = 'sms' and m.conversation_id is not null and m.fts @@ i.tsq
    order by m.conversation_id, m.created_at desc, m.id desc
  ), thread_hits as (
    select 'thread'::text as entity_type, m.id as entity_id,
      (select p.id from public.properties p where p.id = m.property_id
        and p.org_id = m.org_id and p.org_id in (select org_id from visible_orgs)
        and p.deleted_at is null) as property_id,
      m.conversation_id,
      coalesce(nullif(btrim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')),''), nullif(c.entity_name,''), c.phone_1,
        case when m.direction = 'inbound' then m.from_address else m.to_address end) as title,
      left(m.body,80) as subtitle, 'message'::text as matched_field, m.rank
    from matching_messages m left join public.contacts c on c.org_id = m.org_id and c.id = m.contact_id
    order by m.rank desc, m.created_at desc, m.id desc
    limit (select per_type from bounds)
  )
  select * from property_hits
  union all select * from owner_hits
  union all select * from thread_hits;
  $search$ using q, per_type;
end;
$$;

alter function public.search_global(text, int) owner to postgres;

do $$
begin
  if has_schema_privilege('anon', 'public', 'CREATE')
     or has_schema_privilege('authenticated', 'public', 'CREATE') then
    raise exception 'search_global requires public schema CREATE denied to anon and authenticated';
  end if;
  if (select pg_get_userbyid(proowner) from pg_proc
      where oid = 'public.search_global(text,integer)'::regprocedure) <> 'postgres' then
    raise exception 'search_global must be owned by postgres';
  end if;
end;
$$;

revoke all on function public.search_global(text, int) from public, anon;
grant execute on function public.search_global(text, int) to authenticated, service_role;

notify pgrst, 'reload schema';
