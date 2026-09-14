begin;
-- Immutable verified revisions. Service writers supply provider-read evidence;
-- owner configuration RPCs and dispatch authorization are separate additions.
create table public.dialpad_member_bindings (
 id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null,
 connection_id uuid not null, connection_version bigint not null check(connection_version>0),
 member_user_id uuid not null, revision bigint not null check(revision>0), provider_user_id text not null check(provider_user_id ~ '^[1-9][0-9]*$'),
 verification_reference uuid not null, verification_sha256 text not null check(verification_sha256 ~ '^[0-9a-f]{64}$'),
 verified_at timestamptz not null check(isfinite(verified_at)),
 created_at timestamptz not null default now(), revoked_at timestamptz check(revoked_at is null or (isfinite(revoked_at) and revoked_at>=created_at)),
 unique(org_id,id),unique(org_id,member_user_id,revision),
 foreign key(org_id,connection_id) references public.dialpad_org_connections(org_id,id) on delete restrict,
 foreign key(member_user_id,org_id) references public.memberships(user_id,org_id) on delete restrict
);
create unique index dialpad_active_member_binding on public.dialpad_member_bindings(org_id,member_user_id) where revoked_at is null;
create unique index dialpad_active_provider_binding on public.dialpad_member_bindings(org_id,provider_user_id) where revoked_at is null;
create table public.dialpad_number_grants (
 id uuid primary key default extensions.gen_random_uuid(), org_id uuid not null, binding_id uuid not null,
 revision bigint not null check(revision>0),
 identity_type text not null check(identity_type in ('user','office','department','callcenter')),
 provider_identity_id text not null check(provider_identity_id ~ '^[1-9][0-9]*$'),
 number_e164 text not null check(number_e164 ~ '^\+[1-9][0-9]{1,14}$'),
 permission text not null default 'outbound_caller_id' check(permission='outbound_caller_id'),
 verification_reference uuid not null, verification_sha256 text not null check(verification_sha256 ~ '^[0-9a-f]{64}$'),
 verified_at timestamptz not null check(isfinite(verified_at)),
 created_at timestamptz not null default now(),revoked_at timestamptz check(revoked_at is null or (isfinite(revoked_at) and revoked_at>=created_at)),
 unique(org_id,id),unique(org_id,binding_id,number_e164,identity_type,provider_identity_id,revision),foreign key(org_id,binding_id) references public.dialpad_member_bindings(org_id,id) on delete restrict
);
-- A shared E.164 can have distinct provider contexts; dispatch must choose an exact grant ID.
create unique index dialpad_active_number_grant on public.dialpad_number_grants(org_id,binding_id,number_e164,identity_type,provider_identity_id,permission) where revoked_at is null;
comment on column public.dialpad_member_bindings.verification_reference is 'Opaque provider-read evidence reference, not a credential. Service must retain supporting evidence; not browser-authored authorization.';
create function public.dialpad_guard_binding_revision() returns trigger language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE' then
  if (to_jsonb(new)-'revoked_at') is distinct from (to_jsonb(old)-'revoked_at') or old.revoked_at is not null or new.revoked_at is null then
   raise exception 'DIALPAD_REVISION_IMMUTABLE' using errcode='23514';
  end if;
 end if;
 if new.verified_at>statement_timestamp() or new.revoked_at>statement_timestamp() then raise exception 'DIALPAD_REVISION_TIME_INVALID' using errcode='23514'; end if;
 return new;
end; $$;
create function public.dialpad_validate_new_binding() returns trigger language plpgsql set search_path='' as $$
begin
 perform 1 from public.dialpad_org_connections c where c.org_id=new.org_id and c.id=new.connection_id
 and c.config_version=new.connection_version for share;
 if not found then raise exception 'DIALPAD_CONNECTION_VERSION_STALE' using errcode='23514'; end if;
 return new;
end; $$;
create function public.dialpad_validate_new_grant() returns trigger language plpgsql set search_path='' as $$
begin
 perform 1 from public.dialpad_member_bindings b where b.org_id=new.org_id and b.id=new.binding_id and b.revoked_at is null
 and (new.identity_type<>'user' or new.provider_identity_id=b.provider_user_id) for share;
 if not found then raise exception 'DIALPAD_BINDING_UNAVAILABLE' using errcode='23514'; end if;
 return new;
end; $$;
create trigger dialpad_member_revision_guard before insert or update on public.dialpad_member_bindings for each row execute function public.dialpad_guard_binding_revision();
create trigger dialpad_member_connection_guard before insert on public.dialpad_member_bindings for each row execute function public.dialpad_validate_new_binding();
create trigger dialpad_grant_revision_guard before insert or update on public.dialpad_number_grants for each row execute function public.dialpad_guard_binding_revision();
create trigger dialpad_grant_binding_guard before insert on public.dialpad_number_grants for each row execute function public.dialpad_validate_new_grant();
alter table public.dialpad_member_bindings enable row level security;
alter table public.dialpad_number_grants enable row level security;
revoke all on public.dialpad_member_bindings,public.dialpad_number_grants from public,anon,authenticated,service_role;
grant select,insert on public.dialpad_member_bindings,public.dialpad_number_grants to service_role;
grant update(revoked_at) on public.dialpad_member_bindings,public.dialpad_number_grants to service_role;
revoke all on function public.dialpad_guard_binding_revision(),public.dialpad_validate_new_binding(),public.dialpad_validate_new_grant() from public,anon,authenticated,service_role;
commit;
