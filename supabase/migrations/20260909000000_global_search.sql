-- Global search PR 1. Transactional, repeatable; rehearse on sandra-crm-test.
set lock_timeout = '5s';
set statement_timeout = '120s';

create extension if not exists pg_trgm with schema extensions;
do $$
begin
  if (select extnamespace::regnamespace::text from pg_extension where extname = 'pg_trgm') <> 'extensions' then
    raise exception 'pg_trgm must be installed in extensions';
  end if;
end;
$$;

alter table public.properties add column if not exists search_text text generated always as (
  lower(coalesce(address,'') || ' ' || coalesce(city,'') || ' ' || coalesce(state,'') || ' ' || coalesce(zip,'') || ' ' || coalesce(market,'') || ' ' || coalesce(apn,'') || ' ' || coalesce(mls_number,''))
) stored;
alter table public.contacts add column if not exists search_text text generated always as (
  lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' || coalesce(entity_name,'') || ' ' || coalesce(email,''))
) stored;
alter table public.contacts add column if not exists phone_digits text generated always as (
  regexp_replace(coalesce(phone_1,''),'[^0-9]','','g') || ' ' || regexp_replace(coalesce(phone_2,''),'[^0-9]','','g') || ' ' || regexp_replace(coalesce(phone_3,''),'[^0-9]','','g')
) stored;
alter table public.messages add column if not exists fts tsvector generated always as (
  to_tsvector('simple', regexp_replace(lower(coalesce(body,'')), '[^[:alnum:]]+', ' ', 'g'))
) stored;

create index if not exists properties_search_text_gin on public.properties using gin (search_text extensions.gin_trgm_ops);
create index if not exists contacts_search_text_gin on public.contacts using gin (search_text extensions.gin_trgm_ops);
create index if not exists contacts_phone_digits_gin on public.contacts using gin (phone_digits extensions.gin_trgm_ops);
create index if not exists messages_fts_gin on public.messages using gin (fts);

create or replace function public.search_prefix_tsquery(q text)
returns tsquery
language sql immutable
set search_path = public, pg_temp
as $$
  select to_tsquery('simple', string_agg(token || ':*', ' & ' order by ordinal))
  from (
    select token, ordinal
    from regexp_split_to_table(regexp_replace(lower(coalesce(q,'')), '[^[:alnum:]]+', ' ', 'g'), ' +') with ordinality as tokens(token, ordinal)
    where token <> ''
    order by ordinal
    limit 6
  ) words;
$$;

create or replace function public.search_global(q text, per_type int default 5)
returns table (entity_type text, entity_id uuid, property_id uuid, conversation_id uuid, title text, subtitle text, matched_field text, rank real)
language sql stable security invoker
set search_path = public, pg_temp
as $$
  with bounds as (
    select left(btrim(coalesce($1,'')),100) as q,
      least(greatest(coalesce($2,5),1),10) as per_type
  ), input as (
    select bounds.*,
      regexp_replace(q,'[^0-9]','','g') as qd,
      replace(replace(replace(lower(q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      public.search_prefix_tsquery(q) as tsq
    from bounds where length(q) >= 3
  ), property_hits as (
    select 'property'::text as entity_type, p.id as entity_id, p.id as property_id,
      null::uuid as conversation_id, p.address as title,
      coalesce(p.city,'') || ' ' || coalesce(p.state,'') || ' ' || coalesce(p.zip,'') as subtitle,
      'address'::text as matched_field,
      (case when lower(p.address) like i.q_like || '%' escape E'\\' then 1 else 0 end + extensions.similarity(p.search_text,lower(i.q)))::real as rank
    from public.properties p cross join input i
    where p.deleted_at is null and (
      p.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or p.search_text OPERATOR(extensions.%) lower(i.q)
    )
    order by rank desc, p.updated_at desc, p.id desc
    limit (select per_type from bounds)
  ), contact_candidates as (
    select c.*, i.q, i.q_like, i.qd,
      (select p.id from public.properties p
       where (p.homeowner_contact_id = c.id or p.agent_contact_id = c.id) and p.deleted_at is null
       order by p.updated_at desc, p.id desc limit 1) as destination_property,
      (select m.conversation_id from public.messages m
       where m.contact_id = c.id and m.channel = 'sms' and m.conversation_id is not null
       order by m.created_at desc, m.id desc limit 1) as destination_conversation
    from public.contacts c cross join input i
    where c.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or c.search_text OPERATOR(extensions.%) lower(i.q)
      or (length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')
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
    where i.tsq is not null and m.channel = 'sms' and m.conversation_id is not null and m.fts @@ i.tsq
    order by m.conversation_id, m.created_at desc, m.id desc
  ), thread_hits as (
    select 'thread'::text as entity_type, m.id as entity_id, m.property_id,
      m.conversation_id,
      coalesce(nullif(btrim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')),''), nullif(c.entity_name,''), c.phone_1,
        case when m.direction = 'inbound' then m.from_address else m.to_address end) as title,
      left(m.body,80) as subtitle, 'message'::text as matched_field, m.rank
    from matching_messages m left join public.contacts c on c.id = m.contact_id
    order by m.rank desc, m.created_at desc, m.id desc
    limit (select per_type from bounds)
  )
  select * from property_hits
  union all select * from owner_hits
  union all select * from thread_hits;
$$;

revoke all on function public.search_global(text, int) from public;
grant execute on function public.search_global(text, int) to authenticated, service_role;
notify pgrst, 'reload schema';
