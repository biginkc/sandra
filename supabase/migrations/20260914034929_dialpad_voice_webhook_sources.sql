begin;
create table public.dialpad_voice_webhook_sources (
 id uuid primary key default extensions.gen_random_uuid(),org_id uuid not null,
 connection_id uuid not null,connection_version bigint not null,
 webhook_secret_reference text not null unique check(webhook_secret_reference ~ '^env:DIALPAD_[A-Z0-9_]{1,119}$'),
 created_at timestamptz not null default clock_timestamp(),unique(org_id,id),
 foreign key(org_id,connection_id,connection_version) references public.dialpad_connection_revisions(org_id,connection_id,config_version)
);
create function public.dialpad_voice_webhook_source_verified() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.dialpad_connection_revisions r where r.org_id=new.org_id and r.connection_id=new.connection_id and r.config_version=new.connection_version and r.enabled and r.verified_at is not null) then
 raise exception 'DIALPAD_SOURCE_UNVERIFIED' using errcode='23514';end if;return new;
end;$$;
create trigger dialpad_voice_webhook_source_verified before insert on public.dialpad_voice_webhook_sources for each row execute function public.dialpad_voice_webhook_source_verified();
create trigger dialpad_voice_webhook_sources_immutable before update or delete on public.dialpad_voice_webhook_sources for each row execute function public.dialpad_history_immutable();
alter table public.dialpad_voice_webhook_sources enable row level security;
revoke all on public.dialpad_voice_webhook_sources from public,anon,authenticated,service_role;
grant select,insert on public.dialpad_voice_webhook_sources to service_role;
alter table public.dialpad_voice_event_inbox add column webhook_source_id uuid;
alter table public.dialpad_voice_event_inbox add constraint dialpad_voice_inbox_source_fk foreign key(org_id,webhook_source_id) references public.dialpad_voice_webhook_sources(org_id,id);
-- No backfill: old signatures do not establish their provider company.
create function public.dialpad_voice_inbox_provenance_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if new.org_id is distinct from old.org_id or new.webhook_source_id is distinct from old.webhook_source_id or new.envelope_sha256 is distinct from old.envelope_sha256 or new.payload is distinct from old.payload then
 raise exception 'DIALPAD_RECEIPT_IMMUTABLE' using errcode='23514'; end if;return new;
end;$$;
create trigger dialpad_voice_inbox_provenance_immutable before update on public.dialpad_voice_event_inbox for each row execute function public.dialpad_voice_inbox_provenance_immutable();
commit;
