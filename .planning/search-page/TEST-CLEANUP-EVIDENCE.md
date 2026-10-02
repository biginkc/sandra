# TEST project cleanup evidence (ncsngxlcyxylaeskiteu)

Window: 2026-10-02 03:55:47 to 03:55:49 CDT. Pooler session, one transaction, no CASCADE, no table resets, no storage changes.

Prior definitions in origin/main migrations (git grep `function [public.]<name>`): none for any of the 7 names. All 7 were therefore dropped, not restored.

## Before

### engagement_state(properties)
- identity args: properties
- owner: postgres
- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

```sql
CREATE OR REPLACE FUNCTION public.engagement_state(properties)
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select case
    when exists (
      select 1 from public.messages m
       where m.property_id = $1.id and m.direction = 'inbound'
    ) then 'replied'
    when exists (
      select 1 from public.messages m
       where m.property_id = $1.id and m.direction = 'outbound'
    ) then 'attempted'
    else 'never_contacted'
  end
$function$

```

### has_open_tasks(properties)
- identity args: properties
- owner: postgres
- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

```sql
CREATE OR REPLACE FUNCTION public.has_open_tasks(properties)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select exists (
    select 1 from public.tasks t
     where t.related_property_id = $1.id
       and t.status = 'open'
  )
$function$

```

### has_unread_inbound(properties)
- identity args: properties
- owner: postgres
- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

```sql
CREATE OR REPLACE FUNCTION public.has_unread_inbound(properties)
 RETURNS boolean
 LANGUAGE sql
 STABLE
AS $function$
  select exists (
    select 1 from public.messages m
     where m.property_id = $1.id
       and m.direction = 'inbound'
       and m.read_at is null
  )
$function$

```

### property_list_count(properties)
- identity args: properties
- owner: postgres
- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

```sql
CREATE OR REPLACE FUNCTION public.property_list_count(properties)
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  select count(*)::integer
    from public.property_lists pl
   where pl.property_id = $1.id
$function$

```

### property_list_ids(properties)
- identity args: properties
- owner: postgres
- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

```sql
CREATE OR REPLACE FUNCTION public.property_list_ids(properties)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(array_agg(pl.list_id), '{}'::uuid[])
    from public.property_lists pl
   where pl.property_id = $1.id
$function$

```

### property_tag_ids(properties)
- identity args: properties
- owner: postgres
- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

```sql
CREATE OR REPLACE FUNCTION public.property_tag_ids(properties)
 RETURNS uuid[]
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(array_agg(pt.tag_id), '{}'::uuid[])
    from public.property_tags pt
   where pt.property_id = $1.id
$function$

```

### search_properties(text,boolean)
- identity args: q text, include_messages boolean
- owner: postgres
- ACL: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}

```sql
CREATE OR REPLACE FUNCTION public.search_properties(q text, include_messages boolean DEFAULT true)
 RETURNS SETOF properties
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    select left(btrim(coalesce($1,'')),100) as q
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
$function$

```

pg_depend dependents (non-internal): []

Function bodies mentioning a name: [{"fn":"compute_sendillo_sms_health()"}] (false positive: `has_unread_inbound` is a column alias inside compute_sendillo_sms_health, not a call)

auth.users like sp-%@example.test: 0; their memberships: 0; spike_* functions: 0

## Action
`drop function public.<name>(<args>)` x7 (no cascade), then `notify pgrst, 'reload schema'`, committed.

## After
Remaining target functions: 0; dependents: []; sp-* users: 0; sp-* memberships: 0; spike_* functions: 0.
