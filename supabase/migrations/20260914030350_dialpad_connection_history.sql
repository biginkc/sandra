begin;
-- Reference routes are company-bound for their entire lifetime. Rotating the
-- secret behind a reference is allowed only within the same provider company.
-- Old tokens are not retained; workers must verify current credential company.
create table public.dialpad_credential_reference_companies (
 credential_reference text primary key,
 provider_company_id text not null
);
create table public.dialpad_connection_revisions (
 org_id uuid not null, connection_id uuid not null, config_version bigint not null,
 provider_company_id text not null, provider_office_id text,
 enabled boolean not null, verified_at timestamptz,
 credential_reference text not null,
 cti_client_id text, allowed_origins text[] not null,
 connection_created_at timestamptz not null, captured_at timestamptz not null default statement_timestamp(),
 primary key(org_id,connection_id,config_version),
 foreign key(org_id,connection_id) references public.dialpad_org_connections(org_id,id) on delete restrict,
 foreign key(credential_reference) references public.dialpad_credential_reference_companies(credential_reference) on delete restrict
);
create function public.dialpad_history_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'DIALPAD_CONNECTION_HISTORY_IMMUTABLE' using errcode='23514'; end $$;
create trigger dialpad_connection_history_immutable before update or delete on public.dialpad_connection_revisions for each row execute function public.dialpad_history_immutable();
create trigger dialpad_credential_company_immutable before update or delete on public.dialpad_credential_reference_companies for each row execute function public.dialpad_history_immutable();
create function public.dialpad_capture_connection_revision() returns trigger language plpgsql security definer set search_path='' as $$
declare company text;
begin
 -- Connection row already locked by its write. Unique reference insertion
 -- serializes cross-org races without taking another connection row lock.
 insert into public.dialpad_credential_reference_companies values(new.credential_reference,new.provider_company_id) on conflict do nothing;
 select provider_company_id into company from public.dialpad_credential_reference_companies where credential_reference=new.credential_reference;
 if company is distinct from new.provider_company_id then raise exception 'DIALPAD_CREDENTIAL_COMPANY_CONFLICT' using errcode='23514'; end if;
 insert into public.dialpad_connection_revisions(org_id,connection_id,config_version,provider_company_id,provider_office_id,enabled,verified_at,
 credential_reference,cti_client_id,allowed_origins,connection_created_at)
 values(new.org_id,new.id,new.config_version,new.provider_company_id,new.provider_office_id,new.enabled,new.verified_at,
 new.credential_reference,new.cti_client_id,new.allowed_origins,new.created_at);
 return new;
end $$;
-- Existing rows establish only the presently known revision, never missing past versions.
do $$ begin
 if exists(select credential_reference from public.dialpad_org_connections group by credential_reference having count(distinct provider_company_id)>1) then
 raise exception 'DIALPAD_CREDENTIAL_COMPANY_CONFLICT' using errcode='23514'; end if;
end $$;
insert into public.dialpad_credential_reference_companies select distinct credential_reference,provider_company_id from public.dialpad_org_connections;
insert into public.dialpad_connection_revisions(org_id,connection_id,config_version,provider_company_id,provider_office_id,enabled,verified_at,credential_reference,cti_client_id,allowed_origins,connection_created_at)
 select org_id,id,config_version,provider_company_id,provider_office_id,enabled,verified_at,credential_reference,cti_client_id,allowed_origins,created_at from public.dialpad_org_connections;
create trigger dialpad_capture_connection_revision after insert or update on public.dialpad_org_connections for each row execute function public.dialpad_capture_connection_revision();
alter table public.dialpad_connection_revisions enable row level security;
alter table public.dialpad_credential_reference_companies enable row level security;
revoke all on public.dialpad_connection_revisions,public.dialpad_credential_reference_companies from public,anon,authenticated,service_role;
grant select on public.dialpad_connection_revisions,public.dialpad_credential_reference_companies to service_role;
revoke all on function public.dialpad_history_immutable(),public.dialpad_capture_connection_revision() from public,anon,authenticated,service_role;
commit;
