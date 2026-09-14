-- Preparation only: no acquisition credit, provider calls, or browser grants.
begin;

create table public.dialpad_voice_intents (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  property_id uuid not null,
  assignment_episode_id uuid,
  binding_token_hash text not null check (binding_token_hash ~ '^[0-9a-f]{64}$'),
  dialpad_user_id text not null check (dialpad_user_id ~ '^[0-9]+$'),
  destination_e164 text not null check (destination_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  caller_id_e164 text not null check (caller_id_e164 ~ '^\+[1-9][0-9]{1,14}$'),
  client_idempotency_key uuid not null,
  status text not null default 'prepared' check (status in ('prepared','initiation_unconfirmed','linked','failed','cancelled')),
  provider_call_id text check (provider_call_id ~ '^[0-9]+$'),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id,org_id),
  unique (org_id,binding_token_hash),
  unique (org_id,actor_user_id,client_idempotency_key),
  unique (org_id,provider_call_id),
  foreign key (property_id,org_id) references public.properties(id,org_id) on delete restrict,
  foreign key (assignment_episode_id,property_id,org_id) references public.acquisition_assignment_episodes(id,property_id,org_id) on delete restrict,
  check (status <> 'linked' or provider_call_id is not null)
);
comment on column public.dialpad_voice_intents.id is 'Opaque UUID carried as custom_data; identifies intent but does not authenticate provider evidence.';

create table public.dialpad_voice_event_inbox (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  envelope_sha256 text not null check (envelope_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  received_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','processing','processed','retry','quarantined','failed')),
  attempt_count integer not null default 0 check (attempt_count>=0),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  processed_at timestamptz,
  unique (org_id,envelope_sha256),
  check ((status='processing') = (lease_token is not null and lease_expires_at is not null)),
  check ((lease_token is null) = (lease_expires_at is null)),
  check (status <> 'processed' or processed_at is not null)
);
comment on table public.dialpad_voice_event_inbox is 'Server persists authenticated envelope digest and parsed payload before HTTP acknowledgement. No raw JWT/API keys. Worker claims with conditional update and lease token; payload is immutable.';
create index dialpad_voice_event_work_idx on public.dialpad_voice_event_inbox(next_attempt_at,received_at) where status in ('pending','retry');
create index dialpad_voice_event_expired_lease_idx on public.dialpad_voice_event_inbox(lease_expires_at) where status='processing';

create table public.dialpad_recording_artifacts (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete restrict,
  provider_call_id text not null check (provider_call_id ~ '^[0-9]+$'),
  provider_recording_id text not null check (length(btrim(provider_recording_id)) between 1 and 500),
  recording_kind text not null check (length(btrim(recording_kind)) between 1 and 100),
  intent_id uuid,
  status text not null default 'awaiting_provider' check (status in ('awaiting_provider','pending','processing','retry','available','denied','failed')),
  attempt_count integer not null default 0 check (attempt_count>=0),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error_code text,
  storage_bucket text,
  storage_path text,
  content_sha256 text check (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_count bigint check (byte_count>0),
  decoded_duration_seconds numeric check (decoded_duration_seconds>0 and decoded_duration_seconds<'Infinity'::numeric),
  media_type text check (media_type in ('audio/mpeg','audio/mp4','audio/wav','audio/x-wav','audio/ogg','audio/webm','audio/flac')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id,provider_call_id,provider_recording_id),
  foreign key (intent_id,org_id) references public.dialpad_voice_intents(id,org_id) on delete restrict,
  check ((status='processing') = (lease_token is not null and lease_expires_at is not null)),
  check ((lease_token is null) = (lease_expires_at is null)),
  check (storage_path is null or (length(btrim(storage_path))>0 and storage_path !~ '(^/|://|(^|/)\.\.(/|$))')),
  check (status <> 'available' or (storage_bucket is not null and storage_path is not null and content_sha256 is not null and byte_count is not null and decoded_duration_seconds is not null and media_type is not null and verified_at is not null))
);
comment on table public.dialpad_recording_artifacts is 'Owned decoded media only. No provider URL can establish available status. Server must verify full audio and upload before marking available. Separate segments remain separate rows.';
create index dialpad_recording_work_idx on public.dialpad_recording_artifacts(next_attempt_at,created_at) where status in ('pending','retry');
create index dialpad_recording_expired_lease_idx on public.dialpad_recording_artifacts(lease_expires_at) where status='processing';

create function public.dialpad_voice_persistence_guard()
-- Definer reads acquisition_commands, whose direct service-role access is revoked.
-- Trigger-only function: EXECUTE revoked; attached tables accept server writes only.
returns trigger language plpgsql security definer set search_path='' as $$
declare v_binding jsonb;
begin
  if tg_table_name='dialpad_voice_intents' then
    if tg_op='INSERT' then
      if encode(extensions.digest(new.id::text,'sha256'),'hex') <> new.binding_token_hash then
        raise exception 'DIALPAD_BINDING_DIGEST_MISMATCH' using errcode='23514';
      end if;
      select result into v_binding from public.acquisition_commands where org_id=new.org_id and operation='bind_call_context' and context_key_hash=new.binding_token_hash;
      if v_binding is null or v_binding->>'tracked' is distinct from 'true'
        or v_binding->>'orgId' is distinct from new.org_id::text
        or v_binding->>'propertyId' is distinct from new.property_id::text
        or v_binding->>'actorUserId' is distinct from new.actor_user_id::text
        or v_binding->>'assignmentEpisodeId' is distinct from new.assignment_episode_id::text then
        raise exception 'DIALPAD_CALL_BINDING_REQUIRED' using errcode='23514';
      end if;
    else
      if (to_jsonb(new)-array['status','provider_call_id','last_error_code','updated_at']) is distinct from
        (to_jsonb(old)-array['status','provider_call_id','last_error_code','updated_at'])
        or (old.provider_call_id is not null and new.provider_call_id is distinct from old.provider_call_id) then
        raise exception 'DIALPAD_INTENT_IDENTITY_IMMUTABLE' using errcode='23514';
      end if;
    end if;
    new.updated_at:=statement_timestamp();
  elsif tg_table_name='dialpad_voice_event_inbox' then
    if tg_op='UPDATE' and (new.id,new.org_id,new.envelope_sha256,new.payload,new.received_at) is distinct from
      (old.id,old.org_id,old.envelope_sha256,old.payload,old.received_at) then
      raise exception 'DIALPAD_ENVELOPE_IMMUTABLE' using errcode='23514';
    end if;
  elsif tg_table_name='dialpad_recording_artifacts' then
    if tg_op='UPDATE' and (new.id,new.org_id,new.provider_call_id,new.provider_recording_id,new.recording_kind,new.created_at) is distinct from
      (old.id,old.org_id,old.provider_call_id,old.provider_recording_id,old.recording_kind,old.created_at) then
      raise exception 'DIALPAD_RECORDING_IDENTITY_IMMUTABLE' using errcode='23514';
    end if;
    if tg_op='UPDATE' and old.intent_id is not null and new.intent_id is distinct from old.intent_id then
      raise exception 'DIALPAD_RECORDING_INTENT_IMMUTABLE' using errcode='23514';
    end if;
    if new.intent_id is not null and not exists(select 1 from public.dialpad_voice_intents i where i.id=new.intent_id and i.org_id=new.org_id and i.provider_call_id=new.provider_call_id) then
      raise exception 'DIALPAD_RECORDING_CALL_MISMATCH' using errcode='23514';
    end if;
    if new.status='available' and not exists(select 1 from storage.buckets b where b.id=new.storage_bucket and b.public is false) then
      raise exception 'DIALPAD_PRIVATE_STORAGE_REQUIRED' using errcode='23514';
    end if;
    new.updated_at:=statement_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function public.dialpad_voice_persistence_guard() from public,anon,authenticated,service_role;
create trigger dialpad_voice_intents_guard before insert or update on public.dialpad_voice_intents for each row execute function public.dialpad_voice_persistence_guard();
create trigger dialpad_voice_event_inbox_guard before update on public.dialpad_voice_event_inbox for each row execute function public.dialpad_voice_persistence_guard();
create trigger dialpad_recording_artifacts_guard before insert or update on public.dialpad_recording_artifacts for each row execute function public.dialpad_voice_persistence_guard();

alter table public.dialpad_voice_intents enable row level security;
alter table public.dialpad_voice_event_inbox enable row level security;
alter table public.dialpad_recording_artifacts enable row level security;
revoke all on public.dialpad_voice_intents,public.dialpad_voice_event_inbox,public.dialpad_recording_artifacts from public,anon,authenticated,service_role;
grant select,insert,update on public.dialpad_voice_intents,public.dialpad_voice_event_inbox,public.dialpad_recording_artifacts to service_role;
commit;
