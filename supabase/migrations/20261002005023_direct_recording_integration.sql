-- Sandra direct-call seller recording integration.
-- This is additive: existing migrations remain immutable. Provider events are
-- first recorded in direct_call_events and this service-only ledger holds the
-- recording until wrap-up creates the call_activity row.
begin;

alter table public.call_activities
  add column if not exists direct_call_id uuid references public.direct_calls(id) on delete set null;

create unique index if not exists call_activities_direct_call_unique_idx
  on public.call_activities (direct_call_id)
  where direct_call_id is not null;

alter table public.call_recordings
  add column if not exists provider_recording_id text,
  add column if not exists provider_call_control_id text,
  add column if not exists provider_call_leg_id text,
  add column if not exists provider_call_session_id text,
  add column if not exists storage_bucket text;

create unique index if not exists call_recordings_provider_recording_unique_idx
  on public.call_recordings (provider_recording_id);

create table if not exists public.direct_call_recordings (
  id uuid primary key default gen_random_uuid(),
  direct_call_id uuid not null references public.direct_calls(id) on delete cascade,
  provider_recording_id text not null,
  provider_call_control_id text not null,
  provider_call_leg_id text,
  provider_call_session_id text,
  status text not null default 'pending' check (status in ('pending','available','failed')),
  storage_bucket text,
  storage_path text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  error_code text,
  error_message text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 100),
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_recording_id),
  unique (direct_call_id)
);

create index if not exists direct_call_recordings_call_idx
  on public.direct_call_recordings (direct_call_id);

alter table public.direct_call_recordings enable row level security;
revoke all on table public.direct_call_recordings from public, anon, authenticated;
grant all on table public.direct_call_recordings to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sandra-direct-recordings', 'sandra-direct-recordings', false, 67108864,
  array['audio/wav','audio/x-wav','audio/wave','application/octet-stream']::text[])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

commit;
