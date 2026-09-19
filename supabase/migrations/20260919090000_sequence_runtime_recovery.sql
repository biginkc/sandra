-- Durable recovery state for native sequence step claims.
--
-- A sequence claim is an audit record as well as a double-send fence.  A
-- provider timeout (or a process crash after authorization) cannot be
-- treated as a no-send, so the claim remains active until it is reconciled.

alter table public.sequence_step_runs
  add column if not exists claim_active boolean not null default true,
  -- Existing claims may already have reached a provider; unknown is the
  -- only safe backfill. Fresh claims explicitly use not_attempted below.
  add column if not exists attempt_outcome text not null default 'unknown',
  add column if not exists attempt_started_at timestamptz,
  add column if not exists attempt_count integer not null default 0,
  add column if not exists failure_reason text,
  add column if not exists recovery_actor_user_id uuid,
  add column if not exists recovery_action text,
  add column if not exists recovery_evidence text;

alter table public.sequence_step_runs
  drop constraint if exists sequence_step_runs_attempt_outcome_check;
alter table public.sequence_step_runs
  add constraint sequence_step_runs_attempt_outcome_check
  check (attempt_outcome in ('not_attempted', 'definitively_rejected', 'accepted', 'unknown'));

drop index if exists public.idx_step_runs_unique_enrollment_step;
create unique index if not exists idx_step_runs_active_enrollment_step
  on public.sequence_step_runs (enrollment_id, step_id)
  where claim_active;

do $$
begin
  if exists (
    select 1
      from pg_index x
      join pg_class t on t.oid = x.indrelid
     where t.oid = 'public.sequence_step_runs'::regclass
       and x.indisunique
       and x.indpred is null
       and (
         select array_agg(a.attname::text order by keys.ord)
           from unnest(x.indkey) with ordinality as keys(attnum, ord)
           join pg_attribute a
             on a.attrelid = x.indrelid
            and a.attnum = keys.attnum
       ) = array['enrollment_id', 'step_id']::text[]
  ) then
    raise exception 'unconditional sequence_step_runs enrollment/step unique index survived migration';
  end if;
  if not exists (
    select 1
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
     where x.indrelid = 'public.sequence_step_runs'::regclass
       and i.relname = 'idx_step_runs_active_enrollment_step'
       and x.indisunique
       and x.indpred is not null
       and (
         select array_agg(a.attname::text order by keys.ord)
           from unnest(x.indkey) with ordinality as keys(attnum, ord)
           join pg_attribute a
             on a.attrelid = x.indrelid
            and a.attnum = keys.attnum
       ) = array['enrollment_id', 'step_id']::text[]
       and pg_get_expr(x.indpred, x.indrelid) in ('claim_active', '(claim_active)')
  ) then
    raise exception 'active sequence_step_runs claim index is missing';
  end if;
end;
$$;

-- Sequence step runs are runtime-owned audit/fence rows. The historical
-- tenant-wide UPDATE/DELETE policies allowed an authenticated member to clear
-- an accepted/unknown claim (or delete it) and then make the next tick send
-- again. Keep service-role cron and direct database administration paths
-- available, while rejecting all normal authenticated/anon writes.
create or replace function public.guard_sequence_step_run_runtime_write()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin', 'service_role') then
    raise exception using
      errcode = '42501',
      message = 'sequence step runs are runtime-managed';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists sequence_step_runs_runtime_write_guard
  on public.sequence_step_runs;
create trigger sequence_step_runs_runtime_write_guard
  before insert or update or delete on public.sequence_step_runs
  for each row execute function public.guard_sequence_step_run_runtime_write();

-- The final native-sequence gate and provider intent marker are one awaited
-- operation.  The caller must invoke the provider immediately after this RPC
-- returns true; no state read is used as proof that a provider call occurred.
create or replace function public.authorize_sequence_provider_attempt(
  p_enrollment_id uuid,
  p_step_id uuid,
  p_claim_id uuid,
  p_contact_id uuid,
  p_property_id uuid,
  p_phone text,
  p_message_id uuid
)
returns table (authorized boolean, reason text, attempt_outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  c public.contacts%rowtype;
  p public.properties%rowtype;
  latest_consent text;
  normalized_phone text;
begin
  -- Lock the enrollment before checking the expected step.  A committed
  -- cancel/pause before this point therefore wins and no provider call is
  -- authorized; a concurrent cancel waits until this transaction commits.
  select * into e
    from public.sequence_enrollments
   where id = p_enrollment_id
   for update;

  -- Lock and validate the claim before any rejection write. A replay with a
  -- mismatched step, or a second authorization after intent, must never
  -- downgrade an accepted/unknown claim or mutate an unrelated row.
  select * into r
    from public.sequence_step_runs
   where id = p_claim_id
     and enrollment_id = e.id
     and claim_active
   for update;
  if r.id is null then
    return query select false, 'sequence claim is not active', 'definitively_rejected';
    return;
  end if;
  if r.attempt_outcome <> 'not_attempted' then
    return query select false, 'sequence claim already has a provider outcome', r.attempt_outcome;
    return;
  end if;

  select * into s
    from public.sequence_steps
   where id = p_step_id
     and sequence_id = e.sequence_id;

  if e.id is null or s.id is null or e.status <> 'active'
     or e.current_step_index <> s.step_index
     or r.step_id <> s.id
     or not exists (
       select 1 from public.sequences seq
        where seq.id = e.sequence_id and seq.org_id = e.org_id
     ) then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'enrollment is no longer active at this step'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'enrollment is no longer active at this step', 'definitively_rejected';
    return;
  end if;

  select * into p
    from public.properties
   where id = p_property_id
     and org_id = e.org_id;
  select * into c
    from public.contacts
   where id = p_contact_id
     and org_id = e.org_id;

  if p.id is null or c.id is null or e.property_id <> p.id
     or e.contact_id <> c.id then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'sequence contact/property boundary no longer matches'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'sequence contact/property boundary no longer matches', 'definitively_rejected';
    return;
  end if;

  if p.is_dnc_locked
     or p.status in ('dead', 'closed', 'offer_sent', 'under_contract')
     or p.outreach_dispo in ('wrong_number', 'bad_number', 'dnc', 'opted_out',
                             'nurture', 'callback_requested', 'booked_appointment')
     or c.do_not_contact
     or c.sms_opted_out then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'current sequence suppression state blocks SMS'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'current sequence suppression state blocks SMS', 'definitively_rejected';
    return;
  end if;

  select ce.event_type into latest_consent
    from public.consent_events ce
   where ce.contact_id = c.id
     and ce.org_id = e.org_id
     and ce.channel = 'sms'
     and ce.event_type in (
       'opt_in_marketing_written', 'opt_in_confirmed',
       'opt_in_informational', 'opt_out', 'provider_auto_opt_out'
     )
   order by ce.occurred_at desc,
            (ce.event_type in ('opt_out', 'provider_auto_opt_out')) desc,
            ce.id desc
   limit 1;
  if latest_consent in ('opt_out', 'provider_auto_opt_out') then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'contact has opted out of SMS'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'contact has opted out of SMS', 'definitively_rejected';
    return;
  end if;

  normalized_phone := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  -- Match the application's normalizePhone contract: US ten-digit values
  -- and their +1 eleven-digit form are equivalent; other country formats are
  -- rejected before the provider boundary.
  if length(normalized_phone) = 10 then
    normalized_phone := '1' || normalized_phone;
  elsif length(normalized_phone) <> 11 or left(normalized_phone, 1) <> '1' then
    normalized_phone := '';
  end if;
  if normalized_phone = '' or not exists (
    select 1 from (values (c.phone_1, c.phone_1_type), (c.phone_2, c.phone_2_type), (c.phone_3, c.phone_3_type)) phones(phone, phone_type)
     where case
       when length(regexp_replace(coalesce(phones.phone, ''), '[^0-9]', '', 'g')) = 10
         then '1' || regexp_replace(coalesce(phones.phone, ''), '[^0-9]', '', 'g')
       else regexp_replace(coalesce(phones.phone, ''), '[^0-9]', '', 'g')
     end = normalized_phone
       and coalesce(phones.phone_type, '') <> 'landline'
  ) then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'selected phone is no longer saved on contact'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'selected phone is no longer saved on contact', 'definitively_rejected';
    return;
  end if;

  if exists (
    select 1 from public.sms_phone_suppressions ps
     where ps.org_id = e.org_id
       and ps.channel = 'sms'
       and case
         when length(regexp_replace(coalesce(ps.phone_e164, ''), '[^0-9]', '', 'g')) = 10
           then '1' || regexp_replace(coalesce(ps.phone_e164, ''), '[^0-9]', '', 'g')
         else regexp_replace(coalesce(ps.phone_e164, ''), '[^0-9]', '', 'g')
       end = normalized_phone
  ) then
    update public.sequence_step_runs as sr
       set attempt_outcome = 'definitively_rejected',
           failure_reason = 'phone number is suppressed from SMS'
     where sr.id = r.id and sr.claim_active and sr.attempt_outcome = 'not_attempted';
    return query select false, 'phone number is suppressed from SMS', 'definitively_rejected';
    return;
  end if;

  update public.sequence_step_runs as sr
     set message_id = p_message_id,
         attempt_outcome = 'unknown',
         attempt_started_at = now(),
         attempt_count = sr.attempt_count + 1,
         failure_reason = null
   where sr.id = r.id
     and sr.enrollment_id = e.id
     and sr.step_id = s.id
     and sr.claim_active
     and sr.attempt_outcome = 'not_attempted';
  if not found then
    return query select false, 'sequence claim changed before provider intent', 'definitively_rejected';
    return;
  end if;

  return query select true, null::text, 'unknown';
end;
$$;

revoke all on function public.authorize_sequence_provider_attempt(uuid, uuid, uuid, uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.authorize_sequence_provider_attempt(uuid, uuid, uuid, uuid, uuid, text, uuid) to service_role;

-- Cancellation is an audited, tenant-checked transaction. It closes the
-- enrollment while retaining every existing claim as an audit and double-send
-- fence. Cancellation does not reclassify or release a claim. The event and claim
-- recovery metadata are written under the same enrollment lock, so a later
-- resume or tick cannot observe a half-canceled state.
create or replace function public.cancel_sequence_enrollment(
  p_enrollment_id uuid,
  p_actor_user_id uuid default null
)
returns table (
  outcome text,
  claim_id uuid,
  message_id uuid,
  attempt_outcome text,
  claim_active boolean,
  actor_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  resolved_actor uuid;
  retained_claim boolean;
  v_recovery_evidence text;
begin
  select * into e
    from public.sequence_enrollments
   where id = p_enrollment_id
   for update;
  if e.id is null then
    return query select 'not_found', null::uuid, null::uuid, null::text, null::boolean, null::uuid;
    return;
  end if;

  -- Service-role cron may omit an actor; an authenticated caller may omit it
  -- too, but then the authenticated identity is recorded. Never trust a
  -- caller-supplied actor that differs from auth.uid().
  if (coalesce(auth.role(), '') = 'service_role' and p_actor_user_id is not null)
     or (coalesce(auth.role(), '') <> 'service_role' and (
       auth.uid() is null
       or (p_actor_user_id is not null and p_actor_user_id <> auth.uid())
       or not exists (
         select 1 from public.memberships m
          where m.org_id = e.org_id and m.user_id = auth.uid()
       )
     )) then
    return query select 'not_authorized', null::uuid, null::uuid, null::text, null::boolean, null::uuid;
    return;
  end if;
  resolved_actor := case
    when coalesce(auth.role(), '') = 'service_role' then null
    else coalesce(p_actor_user_id, auth.uid())
  end;

  if e.status not in ('active', 'paused') then
    return query select 'not_active', null::uuid, null::uuid, null::text, null::boolean, resolved_actor;
    return;
  end if;

  select ss.* into s
    from public.sequence_steps ss
   where ss.sequence_id = e.sequence_id
     and ss.step_index = e.current_step_index;
  if s.id is not null then
    select * into r
      from public.sequence_step_runs sr
     where sr.enrollment_id = e.id
       and sr.step_id = s.id
       and sr.claim_active
     order by sr.created_at desc, sr.id desc
     limit 1
     for update;
  end if;

  if r.id is not null then
    retained_claim := r.claim_active;
    v_recovery_evidence := format(
      'operator canceled enrollment; claim_id=%s; message_id=%s; attempt_outcome=%s; claim_active=%s',
      r.id, r.message_id, r.attempt_outcome, retained_claim
    );
    update public.sequence_step_runs sr
       set claim_active = case when retained_claim then sr.claim_active else false end,
           recovery_actor_user_id = resolved_actor,
           recovery_action = 'cancel',
           recovery_evidence = v_recovery_evidence
     where sr.id = r.id
       and sr.claim_active;
    claim_active := retained_claim;
  else
    claim_active := null;
  end if;

  update public.sequence_enrollments
     set status = 'completed',
         completed_at = now(),
         next_run_at = null,
         updated_at = now()
   where id = e.id
     and status in ('active', 'paused');

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    e.org_id,
    e.property_id,
    case when resolved_actor is null then 'system' else 'user' end,
    resolved_actor,
    'sequence_canceled',
    jsonb_build_object(
      'enrollment_id', e.id,
      'sequence_id', e.sequence_id,
      'claim_id', r.id,
      'message_id', r.message_id,
      'attempt_outcome', r.attempt_outcome,
      'failure_reason', r.failure_reason,
      'claim_active', claim_active,
      'recovery_action', case when r.id is null then null else 'cancel' end,
      'recovery_evidence', v_recovery_evidence
    ),
    'sequence_enrollments.canceled',
    e.id
  );

  return query select
    'canceled', r.id, r.message_id, r.attempt_outcome, claim_active, resolved_actor;
end;
$$;

revoke all on function public.cancel_sequence_enrollment(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_sequence_enrollment(uuid, uuid)
  to authenticated, service_role;

-- Retrying a proven no-attempt/rejection creates a new claim and retains the
-- old row for audit.  Accepted/unknown claims cannot be retried here.
create or replace function public.retry_sequence_step(
  p_enrollment_id uuid,
  p_actor_user_id uuid default null
)
returns table (outcome text, new_claim_id uuid, step_index integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  prior public.sequence_step_runs%rowtype;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id for update;
  if e.id is null then
    return query select 'not_found', null::uuid, null::integer;
    return;
  end if;
  if (coalesce(auth.role(), '') = 'service_role' and p_actor_user_id is not null)
     or (coalesce(auth.role(), '') <> 'service_role' and (
       auth.uid() is null
       or (p_actor_user_id is not null and p_actor_user_id <> auth.uid())
       or not exists (
       select 1 from public.memberships m
        where m.org_id = e.org_id and m.user_id = auth.uid()
       )
     )) then
    return query select 'reconciliation_required', null::uuid, e.current_step_index;
    return;
  end if;
  if e.status <> 'paused' or e.pause_reason is distinct from 'provider_failed' then
    return query select 'reconciliation_required', null::uuid, e.current_step_index;
    return;
  end if;
  select ss.* into s from public.sequence_steps as ss
   where ss.sequence_id = e.sequence_id and ss.step_index = e.current_step_index;
  if s.id is null then
    return query select 'reconciliation_required', null::uuid, e.current_step_index;
    return;
  end if;
  select * into prior from public.sequence_step_runs
   where enrollment_id = e.id and step_id = s.id and claim_active
   order by created_at desc limit 1;
  if prior.id is not null and (
       prior.attempt_outcome not in ('not_attempted', 'definitively_rejected')
     ) then
    return query select 'reconciliation_required', null::uuid, e.current_step_index;
    return;
  end if;
  if prior.id is not null then
    update public.sequence_step_runs
       set claim_active = false,
           recovery_actor_user_id = coalesce(p_actor_user_id, auth.uid()),
           recovery_action = 'explicit_retry',
           recovery_evidence = 'provider outcome was proven not_attempted or definitively_rejected'
     where id = prior.id and claim_active;
  end if;
  update public.sequence_enrollments
     set status = 'active', pause_reason = null, next_run_at = now(), updated_at = now()
   where id = e.id and status = 'paused';
  -- Do not pre-create a new active claim. The next tick creates it, so this
  -- explicit repair cannot be mistaken for a live worker that already owns
  -- the step.
  return query select 'retried', null::uuid, e.current_step_index;
end;
$$;

revoke all on function public.retry_sequence_step(uuid, uuid) from public, anon, authenticated;
grant execute on function public.retry_sequence_step(uuid, uuid) to authenticated, service_role;

-- Reconcile a duplicate claim under the enrollment lock. A stale claim that
-- never recorded run_at is provably pre-authorization and may be retired for
-- an explicit retry; unknown/accepted claims remain active and are paused for
-- reconciliation so a late worker cannot be mistaken for a safe resend.
create or replace function public.retire_stale_sequence_claim(
  p_enrollment_id uuid,
  p_step_id uuid,
  p_claim_id uuid,
  p_stale_before timestamptz
)
returns table (outcome text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  stale_before timestamptz;
begin
  -- The caller may provide an older cutoff for deterministic recovery tests,
  -- but application clock skew must never make a fresh DB row stale early.
  stale_before := least(
    coalesce(p_stale_before, now() - interval '15 minutes'),
    now() - interval '15 minutes'
  );
  select * into e from public.sequence_enrollments where id = p_enrollment_id for update;
  select * into s from public.sequence_steps where id = p_step_id;
  if e.id is null or s.id is null or e.sequence_id <> s.sequence_id
     or e.current_step_index <> s.step_index then
    return query select 'not_current';
    return;
  end if;
  select * into r from public.sequence_step_runs
   where id = p_claim_id and enrollment_id = p_enrollment_id
     and step_id = p_step_id and claim_active
   for update;
  if r.id is null then
    return query select 'not_active';
    return;
  end if;
  if coalesce(r.attempt_started_at, r.created_at) > stale_before then
    return query select 'active';
    return;
  end if;
  if r.attempt_outcome = 'unknown' or r.attempt_outcome = 'accepted' then
    if e.id is not null and e.status = 'active' and r.attempt_outcome in ('unknown', 'accepted') then
      update public.sequence_enrollments
         set status = 'paused', pause_reason = 'reconciliation_required',
             updated_at = now()
       where id = e.id and status = 'active';
      return query select 'reconciliation_required';
      return;
    end if;
    return query select 'active';
    return;
  end if;
  if r.attempt_outcome = 'definitively_rejected'
     or (r.attempt_outcome = 'not_attempted' and r.run_at is not null) then
    update public.sequence_step_runs as sr
       set claim_active = false,
           failure_reason = coalesce(sr.failure_reason, 'stale claim retired after a proven no-attempt outcome'),
           recovery_action = 'stale_claim_retired',
           recovery_evidence = 'database clock exceeded the bounded stale window'
     where sr.id = r.id and sr.claim_active
       and (sr.attempt_outcome = 'definitively_rejected'
         or (sr.attempt_outcome = 'not_attempted' and sr.run_at is not null));
    update public.sequence_enrollments
       set status = 'paused', pause_reason = 'provider_failed', updated_at = now()
     where id = e.id and status = 'active';
    return query select 'retired';
    return;
  end if;
  update public.sequence_step_runs
     set claim_active = false,
         failure_reason = 'stale claim retired before provider authorization',
         recovery_action = 'stale_claim_retired',
         recovery_evidence = 'database clock exceeded the bounded stale window'
   where id = r.id and claim_active and attempt_outcome = 'not_attempted';
  update public.sequence_enrollments
     set status = 'paused', pause_reason = 'provider_failed',
         updated_at = now()
   where id = e.id and status = 'active';
  return query select 'retired';
end;
$$;

revoke all on function public.retire_stale_sequence_claim(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.retire_stale_sequence_claim(uuid, uuid, uuid, timestamptz) to service_role;

-- Ordinary resume is also fenced against an active claim.  If the current
-- step has an accepted/unknown attempt, changing only enrollment.status would
-- leave a hidden duplicate-send fence and invite an unsafe retry. Proven
-- skipped/rejected claims are retired while the enrollment lock is held.
create or replace function public.resume_sequence_enrollment(
  p_enrollment_id uuid,
  p_actor_user_id uuid default null
)
returns table (outcome text, next_run_at timestamptz)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  e public.sequence_enrollments%rowtype;
  s public.sequence_steps%rowtype;
  r public.sequence_step_runs%rowtype;
  next_at timestamptz;
begin
  select * into e from public.sequence_enrollments where id = p_enrollment_id for update;
  if e.id is null then
    return query select 'not_found', null::timestamptz;
    return;
  end if;
  if (coalesce(auth.role(), '') = 'service_role' and p_actor_user_id is not null)
     or (coalesce(auth.role(), '') <> 'service_role' and (
       auth.uid() is null
       or (p_actor_user_id is not null and p_actor_user_id <> auth.uid())
       or not exists (
         select 1 from public.memberships m
          where m.org_id = e.org_id and m.user_id = auth.uid()
       )
     )) then
    return query select 'not_authorized', null::timestamptz;
    return;
  end if;
  if e.status <> 'paused' then
    return query select 'not_paused', e.next_run_at;
    return;
  end if;
  if coalesce(e.pause_reason, '') in ('reconciliation_required', 'provider_failed') then
    return query select 'retry_required', e.next_run_at;
    return;
  end if;

  select * into s from public.sequence_steps
   where sequence_id = e.sequence_id and step_index = e.current_step_index;
  if s.id is not null then
    select * into r from public.sequence_step_runs
     where enrollment_id = e.id and step_id = s.id and claim_active
     order by created_at desc limit 1
     for update;
    if r.id is not null then
      if r.attempt_outcome not in ('not_attempted', 'definitively_rejected') then
        return query select 'reconciliation_required', e.next_run_at;
        return;
      end if;
      update public.sequence_step_runs
         set claim_active = false,
             recovery_actor_user_id = coalesce(p_actor_user_id, auth.uid()),
             recovery_action = 'resume',
             recovery_evidence = 'paused enrollment resumed with a proven no-attempt claim'
       where id = r.id and claim_active;
    end if;
    next_at := now() + make_interval(mins => s.delay_after_previous_minutes);
  else
    next_at := now();
  end if;

  update public.sequence_enrollments
     set status = 'active', pause_reason = null, next_run_at = next_at, updated_at = now()
   where id = e.id and status = 'paused';
  return query select 'resumed', next_at;
end;
$$;

revoke all on function public.resume_sequence_enrollment(uuid, uuid) from public, anon;
grant execute on function public.resume_sequence_enrollment(uuid, uuid) to authenticated, service_role;
