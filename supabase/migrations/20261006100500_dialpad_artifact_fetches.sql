-- My Leads one-call close, P2 data plane (2.9): hangup-triggered transcript / AI Recap fetch job, with readiness
-- recorded PER ARTIFACT (D5). This is the only fetch job in the plan; transcript and Recap land in the existing
-- call_transcripts table (its trigger mirrors status onto call_activities), not in new provider_* columns.
--
-- Schema only, NO data step. Inert: an enqueue trigger fills cheap rows for calls that end after this lands, but
-- nothing is fetched until the cron route runs, and that route is gated by the per-org artifact_fetch flag
-- (missing = OFF; enforced in SQL by the claim and resolve functions, which only touch orgs with the flag on) and by schemaReady. Retry schedule is measured from hangup: 1, 5, 15 and 60 minutes.
begin;

create table public.dialpad_call_artifact_fetches (
  id uuid primary key default extensions.gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  call_activity_id uuid not null references public.call_activities(id) on delete cascade,
  provider_call_id text not null check (provider_call_id ~ '^[0-9]{1,20}$'),
  artifact text not null check (artifact in ('transcript', 'recap', 'recording_link')),
  state text not null default 'pending' check (state in ('pending', 'available', 'unavailable', 'denied', 'flagged')),
  attempts smallint not null default 0 check (attempts between 0 and 4),
  ended_at timestamptz not null,
  next_attempt_at timestamptz not null,
  lease_until timestamptz,
  last_attempt_at timestamptz,
  last_error text check (last_error is null or length(last_error) <= 64),
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  unique (org_id, call_activity_id, artifact)
);
create index dialpad_artifact_fetches_due_idx on public.dialpad_call_artifact_fetches (next_attempt_at) where state = 'pending';
alter table public.dialpad_call_artifact_fetches enable row level security;
revoke all on table public.dialpad_call_artifact_fetches from public, anon, authenticated, service_role;
grant select on table public.dialpad_call_artifact_fetches to service_role;

-- Enqueue by trigger on the call activity, independent of the projection function's body. No row for a
-- no-answer, voicemail (its transcript is on the payload) or training call.
create or replace function public.dialpad_artifact_fetches_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.dialpad_call_artifact_fetches (org_id, call_activity_id, provider_call_id, artifact, ended_at, next_attempt_at)
  select new.org_id, new.id, new.provider_call_id, a.artifact, new.ended_at,
         new.ended_at + case a.artifact when 'recording_link' then interval '10 minutes' else interval '1 minute' end
  from (values ('transcript'), ('recap'), ('recording_link')) as a(artifact)
  where a.artifact <> 'recording_link' or new.direction = 'outbound'
  on conflict (org_id, call_activity_id, artifact) do nothing;
  return new;
end $$;
revoke all on function public.dialpad_artifact_fetches_enqueue() from public, anon, authenticated, service_role;

create trigger dialpad_artifact_fetches_enqueue_trg
  after insert or update of ended_at, talk_duration_seconds, outcome on public.call_activities
  for each row
  when (new.provider = 'dialpad' and new.ended_at is not null and new.provider_call_id is not null
        and new.call_purpose = 'customer'
        and (new.outcome in ('unknown', 'connected_human') or coalesce(new.talk_duration_seconds, 0) > 0))
  execute function public.dialpad_artifact_fetches_enqueue();

create or replace function public.fn_claim_dialpad_artifact_fetches(
  p_limit integer default 10, p_lease_seconds integer default 120,
  p_artifacts text[] default array['transcript', 'recap']
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit not between 1 and 100 or p_lease_seconds not between 10 and 900 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  with due as (
    select f.id from public.dialpad_call_artifact_fetches f
    where f.state = 'pending' and f.artifact in ('transcript', 'recap') and f.artifact = any(p_artifacts)
      and f.next_attempt_at <= now() and (f.lease_until is null or f.lease_until < now())
      and exists (select 1 from public.my_leads_feature_flags g where g.org_id = f.org_id and g.artifact_fetch)
    order by f.next_attempt_at, f.id limit p_limit for update skip locked),
  upd as (
    update public.dialpad_call_artifact_fetches f
    set lease_until = now() + make_interval(secs => p_lease_seconds)
    from due where f.id = due.id
    returning f.id, f.org_id, f.artifact, f.provider_call_id, f.call_activity_id, f.attempts, f.ended_at)
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'orgId', u.org_id, 'artifact', u.artifact,
    'providerCallId', u.provider_call_id, 'callActivityId', u.call_activity_id, 'attempts', u.attempts,
    'endedAt', u.ended_at) order by u.id), '[]'::jsonb) into v from upd u;
  return v;
end $$;
revoke all on function public.fn_claim_dialpad_artifact_fetches(integer, integer, text[]) from public, anon, authenticated;
grant execute on function public.fn_claim_dialpad_artifact_fetches(integer, integer, text[]) to service_role;

create or replace function public.fn_record_dialpad_artifact_result(
  p_id uuid, p_outcome text, p_error text default null, p_text text default null,
  p_language text default null, p_summary text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v public.dialpad_call_artifact_fetches%rowtype;
  v_attempts smallint;
  v_next timestamptz;
  v_offsets constant interval[] := array[interval '1 minute', interval '5 minutes', interval '15 minutes', interval '60 minutes'];
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_outcome not in ('available', 'not_ready', 'denied', 'error') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v from public.dialpad_call_artifact_fetches where id = p_id for update;
  if not found then raise exception 'NOT_FOUND' using errcode = 'P0002'; end if;
  if v.state <> 'pending' or v.artifact not in ('transcript', 'recap') then
    return jsonb_build_object('state', v.state, 'attempts', v.attempts, 'replayed', true);
  end if;

  if p_outcome = 'available' then
    if v.artifact = 'transcript' then
      insert into public.call_transcripts as t (call_activity_id, status, text, language)
      values (v.call_activity_id, 'available', p_text, p_language)
      on conflict (call_activity_id) do update
        set status = 'available', text = excluded.text, language = excluded.language
        where t.status <> 'available';
    else
      insert into public.call_transcripts as t (call_activity_id, status, summary, summary_status)
      values (v.call_activity_id, 'pending', p_summary, 'available')
      on conflict (call_activity_id) do update
        set summary = excluded.summary, summary_status = 'available'
        where t.summary_status <> 'available';
    end if;
    update public.dialpad_call_artifact_fetches
      set state = 'available', ready_at = now(), last_attempt_at = now(), lease_until = null,
          attempts = least(attempts + 1, 4), last_error = null
      where id = v.id;
    return jsonb_build_object('state', 'available', 'attempts', least(v.attempts + 1, 4));
  end if;

  if p_outcome = 'denied' then
    update public.dialpad_call_artifact_fetches
      set state = 'denied', last_attempt_at = now(), lease_until = null, last_error = left(coalesce(p_error, 'denied'), 64)
      where id = v.id;
    return jsonb_build_object('state', 'denied', 'attempts', v.attempts);
  end if;

  v_attempts := least(v.attempts + 1, 4);
  if v_attempts >= 4 then
    update public.dialpad_call_artifact_fetches
      set state = 'unavailable', attempts = v_attempts, last_attempt_at = now(), lease_until = null,
          last_error = left(coalesce(p_error, p_outcome), 64)
      where id = v.id;
    return jsonb_build_object('state', 'unavailable', 'attempts', v_attempts);
  end if;
  v_next := greatest(v.ended_at + v_offsets[v_attempts + 1], now());
  update public.dialpad_call_artifact_fetches
    set attempts = v_attempts, next_attempt_at = v_next, last_attempt_at = now(), lease_until = null,
        last_error = left(coalesce(p_error, p_outcome), 64)
    where id = v.id;
  return jsonb_build_object('state', 'pending', 'attempts', v_attempts, 'nextAttemptAt', v_next);
end $$;
revoke all on function public.fn_record_dialpad_artifact_result(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_record_dialpad_artifact_result(uuid, text, text, text, text, text) to service_role;

-- recording_link makes no provider call: at its due time the link either reached the attempt (the P1d hangup
-- capture) or the attempt is flagged. Returns the flagged rows so the job can report them.
create or replace function public.fn_resolve_dialpad_recording_links(p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_available int := 0;
  v_flagged jsonb := '[]'::jsonb;
  r record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_limit not between 1 and 500 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  for r in
    select f.id, f.org_id, f.call_activity_id from public.dialpad_call_artifact_fetches f
    where f.state = 'pending' and f.artifact = 'recording_link' and f.next_attempt_at <= now()
      and exists (select 1 from public.my_leads_feature_flags g where g.org_id = f.org_id and g.artifact_fetch)
    order by f.next_attempt_at, f.id limit p_limit for update skip locked
  loop
    if exists (select 1 from public.acquisition_attempts a
               where a.org_id = r.org_id and a.call_activity_id = r.call_activity_id
                 and btrim(coalesce(a.recording_url, '')) <> '') then
      update public.dialpad_call_artifact_fetches
        set state = 'available', ready_at = now(), last_attempt_at = now(), attempts = 1
        where id = r.id;
      v_available := v_available + 1;
    else
      update public.dialpad_call_artifact_fetches
        set state = 'flagged', last_attempt_at = now(), attempts = 1, last_error = 'missing_link'
        where id = r.id;
      v_flagged := v_flagged || jsonb_build_array(jsonb_build_object('id', r.id, 'callActivityId', r.call_activity_id));
    end if;
  end loop;
  return jsonb_build_object('available', v_available, 'flagged', v_flagged);
end $$;
revoke all on function public.fn_resolve_dialpad_recording_links(integer) from public, anon, authenticated;
grant execute on function public.fn_resolve_dialpad_recording_links(integer) to service_role;

commit;
