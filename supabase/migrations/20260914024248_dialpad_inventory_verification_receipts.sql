begin;
-- Evidence-free revisions cannot be upgraded by inventing provider verification.
-- These preparatory tables must be empty before first deployment of this slice.
do $$ begin
 if exists(select 1 from public.dialpad_member_bindings) or exists(select 1 from public.dialpad_number_grants) then
  raise exception 'DIALPAD_EXISTING_REVISIONS_REQUIRE_VERIFICATION_MIGRATION' using errcode='23514';
 end if;
end $$;
create table public.dialpad_inventory_verifications (
 id uuid primary key default extensions.gen_random_uuid(),
 org_id uuid not null,
 connection_id uuid not null,
 connection_version bigint not null check(connection_version>0),
 provider_company_id text not null check(provider_company_id ~ '^[1-9][0-9]*$'),
 member_user_id uuid not null,
 provider_user_id text not null check(provider_user_id ~ '^[1-9][0-9]*$'),
 -- Adapter attests exact casefold equality with the server-resolved member email.
 member_email_matched boolean not null check(member_email_matched),
 callers jsonb not null,
 verified_at timestamptz not null check(isfinite(verified_at)),
 verification_sha256 text not null check(verification_sha256 ~ '^[0-9a-f]{64}$'),
 created_at timestamptz not null default statement_timestamp(),
 unique(org_id,id,verification_sha256,verified_at),
 foreign key(org_id,connection_id) references public.dialpad_org_connections(org_id,id) on delete restrict,
 foreign key(member_user_id,org_id) references public.memberships(user_id,org_id) on delete restrict
);
comment on table public.dialpad_inventory_verifications is 'Service-attested normalized provider inventory. Not a raw response, credential, or browser authorization. Historical company/version is retained even after connection reconfiguration.';
comment on column public.dialpad_inventory_verifications.callers is 'Array of exact objects: identity_type, provider_identity_id, number_e164. Empty inventory is valid and grants no numbers.';

create function public.dialpad_guard_inventory_verification() returns trigger language plpgsql set search_path='' as $$
declare entry jsonb; normalized jsonb;
begin
 if tg_op<>'INSERT' then raise exception 'DIALPAD_VERIFICATION_IMMUTABLE' using errcode='23514'; end if;
 if new.verified_at>statement_timestamp() or new.verified_at<statement_timestamp()-interval '5 minutes' then
  raise exception 'DIALPAD_VERIFICATION_STALE' using errcode='23514';
 end if;
 perform 1 from public.dialpad_org_connections c where c.org_id=new.org_id and c.id=new.connection_id
  and c.config_version=new.connection_version and c.provider_company_id=new.provider_company_id for share;
 if not found then raise exception 'DIALPAD_VERIFICATION_CONNECTION_MISMATCH' using errcode='23514'; end if;
 if jsonb_typeof(new.callers) is distinct from 'array' then raise exception 'DIALPAD_VERIFICATION_INVENTORY_INVALID' using errcode='23514'; end if;
 for entry in select value from jsonb_array_elements(new.callers) loop
  if jsonb_typeof(entry) is distinct from 'object' then raise exception 'DIALPAD_VERIFICATION_INVENTORY_INVALID' using errcode='23514'; end if;
  if (select count(*) from jsonb_object_keys(entry))<>3
   or jsonb_typeof(entry->'identity_type') is distinct from 'string'
   or jsonb_typeof(entry->'provider_identity_id') is distinct from 'string'
   or jsonb_typeof(entry->'number_e164') is distinct from 'string'
   or entry->>'identity_type' not in ('user','office','department','callcenter')
   or entry->>'provider_identity_id' !~ '^[1-9][0-9]*$'
   or entry->>'number_e164' !~ '^\+[1-9][0-9]{1,14}$'
   or (entry->>'identity_type'='user' and entry->>'provider_identity_id'<>new.provider_user_id) then
   raise exception 'DIALPAD_VERIFICATION_INVENTORY_INVALID' using errcode='23514';
  end if;
 end loop;
 -- Canonical set ordering makes equivalent provider inventories produce the same
 -- evidence content regardless of provider order or duplicate exact triples.
 select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) into normalized
 from (select distinct value from jsonb_array_elements(new.callers)) entries;
 new.callers:=normalized;
 new.created_at:=statement_timestamp();
 new.verification_sha256:=encode(extensions.digest(convert_to(jsonb_build_object(
  'org_id',new.org_id,'connection_id',new.connection_id,'connection_version',new.connection_version,
  'provider_company_id',new.provider_company_id,'member_user_id',new.member_user_id,
  'provider_user_id',new.provider_user_id,'member_email_matched',new.member_email_matched,
  'callers',new.callers,'verified_at_epoch',extract(epoch from new.verified_at)
 )::text,'UTF8'),'sha256'),'hex');
 return new;
end $$;
create trigger dialpad_inventory_verification_guard before insert or update or delete on public.dialpad_inventory_verifications
 for each row execute function public.dialpad_guard_inventory_verification();

alter table public.dialpad_member_bindings add constraint dialpad_binding_verification_fk
 foreign key(org_id,verification_reference,verification_sha256,verified_at)
 references public.dialpad_inventory_verifications(org_id,id,verification_sha256,verified_at) on delete restrict;
alter table public.dialpad_number_grants add constraint dialpad_grant_verification_fk
 foreign key(org_id,verification_reference,verification_sha256,verified_at)
 references public.dialpad_inventory_verifications(org_id,id,verification_sha256,verified_at) on delete restrict;

create function public.dialpad_require_revision_verification() returns trigger language plpgsql set search_path='' as $$
declare v public.dialpad_inventory_verifications%rowtype; b public.dialpad_member_bindings%rowtype;
begin
 select * into v from public.dialpad_inventory_verifications where org_id=new.org_id and id=new.verification_reference;
 if not found or v.verification_sha256<>new.verification_sha256 or v.verified_at<>new.verified_at
  or v.verified_at<statement_timestamp()-interval '5 minutes' then
  raise exception 'DIALPAD_REVISION_VERIFICATION_UNAVAILABLE' using errcode='23514';
 end if;
 if tg_table_name='dialpad_member_bindings' then
  if row(new.connection_id,new.connection_version,new.member_user_id,new.provider_user_id)
   is distinct from row(v.connection_id,v.connection_version,v.member_user_id,v.provider_user_id) then
   raise exception 'DIALPAD_REVISION_VERIFICATION_SCOPE_MISMATCH' using errcode='23514';
  end if;
 else
  select * into b from public.dialpad_member_bindings where org_id=new.org_id and id=new.binding_id and revoked_at is null for share;
  if not found or row(b.connection_id,b.connection_version,b.member_user_id,b.provider_user_id)
   is distinct from row(v.connection_id,v.connection_version,v.member_user_id,v.provider_user_id) then
   raise exception 'DIALPAD_REVISION_VERIFICATION_SCOPE_MISMATCH' using errcode='23514';
  end if;
  if not v.callers @> jsonb_build_array(jsonb_build_object('identity_type',new.identity_type,
   'provider_identity_id',new.provider_identity_id,'number_e164',new.number_e164)) then
   raise exception 'DIALPAD_GRANT_NOT_IN_VERIFIED_INVENTORY' using errcode='23514';
  end if;
 end if;
 -- The receipt remains historical evidence, but cannot authorize new revisions
 -- after its connection changes, even while its timestamp is still fresh.
 perform 1 from public.dialpad_org_connections c where c.org_id=v.org_id and c.id=v.connection_id
  and c.config_version=v.connection_version and c.provider_company_id=v.provider_company_id for share;
 if not found then raise exception 'DIALPAD_VERIFICATION_CONNECTION_MISMATCH' using errcode='23514'; end if;
 return new;
end $$;
create trigger dialpad_binding_verified_inventory before insert on public.dialpad_member_bindings
 for each row execute function public.dialpad_require_revision_verification();
create trigger dialpad_grant_verified_inventory before insert on public.dialpad_number_grants
 for each row execute function public.dialpad_require_revision_verification();
alter table public.dialpad_inventory_verifications enable row level security;
revoke all on public.dialpad_inventory_verifications from public,anon,authenticated,service_role;
grant select,insert on public.dialpad_inventory_verifications to service_role;
revoke all on function public.dialpad_guard_inventory_verification(),public.dialpad_require_revision_verification() from public,anon,authenticated,service_role;
commit;
