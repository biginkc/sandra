-- Hugo v1: deterministic, read-only Sandra access inventory.
--
-- This function is deliberately separate from the lifecycle connector. It
-- only exposes rows that already exist in the canonical Sandra organization;
-- it never creates Auth identities, repairs memberships, or changes state.

begin;

-- The existing Sandra lifecycle migration rejects credential-shaped config in
-- its TypeScript adapter. Keep the database inventory safe for legacy rows or
-- another service process as well: unsafe config is represented as {}.
create or replace function public.hugo_config_is_safe(p_value jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from jsonb_each(p_value) as entry(key, value)
      where entry.key not in ('cohort', 'timezone')
         or jsonb_typeof(entry.value) not in ('string', 'null')
    ),
    false
  );
$$;

revoke all on function public.hugo_config_is_safe(jsonb) from public, anon, authenticated;

create or replace function public.hugo_list_access()
returns table (
  email text,
  app_user_id uuid,
  role text,
  config jsonb,
  status text,
  access_expires_at timestamptz,
  has_durable_activity boolean
)
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
begin
  perform public.hugo_require_service_role();
  return query
    select lower(trim(coalesce(u.email, ''))),
           m.user_id,
           m.role,
           case
             when public.hugo_config_is_safe(coalesce(m.hugo_config, '{}'::jsonb))
               then coalesce(m.hugo_config, '{}'::jsonb)
             else '{}'::jsonb
           end,
           m.access_status,
           m.access_expires_at,
           public.hugo_has_durable_activity(m.user_id)
      from public.memberships as m
      join auth.users as u on u.id = m.user_id
     where m.org_id = '00000000-0000-0000-0000-000000000bbb'::uuid
     order by lower(trim(coalesce(u.email, ''))), m.user_id;
end;
$$;

revoke execute on function public.hugo_list_access() from public, anon, authenticated;
grant execute on function public.hugo_list_access() to service_role;

commit;
