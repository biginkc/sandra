-- Search page: search_properties(q, include_messages) returns the visible,
-- non-deleted properties matching a text query across property text, homeowner
-- or agent contact text/phones, and (optionally) SMS message text.
-- Deliberately: no fuzzy branch, no row cap, no status filter (the app layer
-- owns scope; chained PostgREST filters run after this function).
-- Semantics (coordinator decisions 2026-10-02):
--  1. contact -> property linkage requires the property to be in the SAME org as
--     the contact and in visible_orgs (homeowner OR agent contact).
--  2. phone: query digits are normalized; an 11-digit string starting with '1'
--     drops the leading '1' so '+1 555 123 4567' matches stored 5551234567.
--     Phone matching needs >= 3 digits.
--  3. training rows (is_training) are NOT filtered here; the app layer does it.
--  4. message linkage: SMS only, with a conversation; the property must be in the
--     same org as the message, visible, and not deleted; null property_id never
--     matches.
--  5. whitespace: internal whitespace runs in the query collapse to one space.
-- SECURITY DEFINER because RLS evaluation blocks index use (same reason as
-- search_global); the explicit membership gate below is the security boundary.
set lock_timeout = '5s';
set statement_timeout = '120s';

create or replace function public.search_properties(q text, include_messages boolean default true)
returns setof public.properties
language plpgsql stable security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    return;
  end if;
  -- Values remain bound parameters, never interpolated into SQL.
  return query execute $search$
  with visible_orgs as (
    select m.org_id from public.memberships m
    where m.user_id = auth.uid() and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
  ), bounds as not materialized (
    select left(regexp_replace(btrim(coalesce($1,'')), '\s+', ' ', 'g'),100) as q
  ), input as not materialized (
    select bounds.q,
      case when regexp_replace(bounds.q,'[^0-9]','','g') ~ '^1[0-9]{10}$'
        then substr(regexp_replace(bounds.q,'[^0-9]','','g'), 2)
        else regexp_replace(bounds.q,'[^0-9]','','g') end as qd,
      replace(replace(replace(lower(bounds.q), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') as q_like,
      public.search_prefix_tsquery(bounds.q) as tsq
    from bounds where length(bounds.q) >= 3
  ), property_ids as (
    select p.id
    from public.properties p cross join input i
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
      and p.search_text ilike '%' || i.q_like || '%' escape E'\\'
  ), contact_ids as (
    select c.id, c.org_id
    from public.contacts c cross join input i
    where c.org_id in (select org_id from visible_orgs) and (
      c.search_text ilike '%' || i.q_like || '%' escape E'\\'
      or (length(i.qd) >= 3 and c.phone_digits ilike '%' || i.qd || '%')
    )
  ), contact_property_ids as (
    select p.id
    from contact_ids c
    join public.properties p
      on p.org_id = c.org_id
     and (p.homeowner_contact_id = c.id or p.agent_contact_id = c.id)
    where p.org_id in (select org_id from visible_orgs) and p.deleted_at is null
  ), message_property_ids as (
    select mp.id
    from public.messages m cross join input i
    join public.properties mp on mp.id = m.property_id and mp.org_id = m.org_id
    where $2 is true
      and mp.org_id in (select org_id from visible_orgs) and mp.deleted_at is null
      and m.org_id in (select org_id from visible_orgs)
      and i.tsq is not null and m.channel = 'sms'
      and m.conversation_id is not null and m.property_id is not null
      and m.fts @@ i.tsq
  ), candidate_ids as (
    select id from property_ids
    union select id from contact_property_ids
    union select id from message_property_ids
  )
  select p.*
  from public.properties p
  where p.id in (select id from candidate_ids)
    and p.org_id in (select org_id from visible_orgs)
    and p.deleted_at is null;
  $search$ using q, include_messages;
end;
$$;

alter function public.search_properties(text, boolean) owner to postgres;

do $$
begin
  if has_schema_privilege('anon', 'public', 'CREATE')
     or has_schema_privilege('authenticated', 'public', 'CREATE') then
    raise exception 'search_properties requires public schema CREATE denied to anon and authenticated';
  end if;
  if (select pg_get_userbyid(proowner) from pg_proc
      where oid = 'public.search_properties(text,boolean)'::regprocedure) <> 'postgres' then
    raise exception 'search_properties must be owned by postgres';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'search_properties') <> 1 then
    raise exception 'search_properties must have exactly one signature';
  end if;
end;
$$;

revoke all on function public.search_properties(text, boolean) from public, anon;
grant execute on function public.search_properties(text, boolean) to authenticated, service_role;

notify pgrst, 'reload schema';
