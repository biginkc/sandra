begin;
-- Private connection metadata only. Credential values never belong in this table.
create table public.dialpad_org_connections (
 id uuid primary key default extensions.gen_random_uuid(),
 org_id uuid not null unique references public.organizations(id) on delete restrict,
 provider_company_id text not null check(provider_company_id ~ '^[1-9][0-9]*$'),
 provider_office_id text check(provider_office_id ~ '^[1-9][0-9]*$'),
 enabled boolean not null default false,
 config_version bigint not null default 1 check(config_version>0),
 verified_at timestamptz check(verified_at is null or isfinite(verified_at)),
 credential_reference text not null check(credential_reference ~ '^env:[A-Z][A-Z0-9_]{0,127}$'),
 cti_client_id text check(cti_client_id ~ '^[A-Za-z0-9_-]{1,128}$'),
 allowed_origins text[] not null default '{}',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(org_id,id),
 check(not enabled or verified_at is not null)
);
comment on column public.dialpad_org_connections.credential_reference is 'Environment-variable reference such as env:DIALPAD_VOICE_API_KEY; never a token or credential value.';
comment on column public.dialpad_org_connections.allowed_origins is 'Exact HTTPS origins approved for this CTI client; no paths, wildcards, localhost or loopback.';
create function public.dialpad_guard_org_connection()
returns trigger language plpgsql set search_path='' as $$
declare origin text;
begin
 if tg_op='INSERT' and new.config_version<>1 then raise exception 'DIALPAD_CONNECTION_VERSION_INVALID' using errcode='23514'; end if;
 if tg_op='UPDATE' then
  if new.id is distinct from old.id or new.org_id is distinct from old.org_id or new.created_at is distinct from old.created_at then
   raise exception 'DIALPAD_CONNECTION_IDENTITY_IMMUTABLE' using errcode='23514';
  end if;
  if (new.provider_company_id is distinct from old.provider_company_id
   or new.provider_office_id is distinct from old.provider_office_id
   or new.credential_reference is distinct from old.credential_reference
   or new.cti_client_id is distinct from old.cti_client_id
   or new.allowed_origins is distinct from old.allowed_origins)
   and (new.enabled or new.verified_at is not null) then
   raise exception 'DIALPAD_CONNECTION_REVERIFICATION_REQUIRED' using errcode='23514';
  end if;
  if new.config_version<>old.config_version+1 then raise exception 'DIALPAD_CONNECTION_VERSION_INVALID' using errcode='23514'; end if;
 end if;
 if new.verified_at>statement_timestamp() or cardinality(new.allowed_origins)>20
 or (cardinality(new.allowed_origins)>0 and new.cti_client_id is null) then
  raise exception 'DIALPAD_CONNECTION_CONFIGURATION_INVALID' using errcode='23514';
 end if;
 foreach origin in array new.allowed_origins loop
  if origin is null or origin !~ '^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]([a-z0-9-]*[a-z0-9])?(:[1-9][0-9]{0,4})?$'
  or origin ~ '^https://([^/:]+\.)?(localhost|local|internal)(:|$)'
  or (origin ~ ':[0-9]+$' and substring(origin from ':([0-9]+)$')::integer>65535) then
   raise exception 'DIALPAD_CONNECTION_ORIGIN_INVALID' using errcode='23514';
  end if;
 end loop;
 if (select count(*)<>count(distinct value) from unnest(new.allowed_origins) value) then
  raise exception 'DIALPAD_CONNECTION_ORIGIN_INVALID' using errcode='23514';
 end if;
 new.updated_at:=statement_timestamp();
 return new;
end; $$;
create trigger dialpad_org_connection_guard before insert or update on public.dialpad_org_connections
for each row execute function public.dialpad_guard_org_connection();
alter table public.dialpad_org_connections enable row level security;
revoke all on public.dialpad_org_connections from public,anon,authenticated,service_role;
grant select,insert,update on public.dialpad_org_connections to service_role;
revoke all on function public.dialpad_guard_org_connection() from public,anon,authenticated,service_role;
commit;
