-- Confirm records a durable phone-suppression obligation (Codex round 14).
--
-- Before: the confirm RPC resolved the review, cleared attention and opted out
-- the homeowner contact, then the app called phone-level suppression in a
-- SEPARATE step. A process death between the two left no ledger row and no
-- pointer: the phone stayed unsuppressed on other contacts and the review was
-- gone from every queue.
--
-- Now, in the SAME transaction as the confirm, for a deferred opted_out/dnc
-- confirmation the RPC inserts the 'suppression_incomplete' ledger row for the
-- review (idempotent on the (source_type, source_id) identity, same shape the app
-- failure path writes) and merges the hold pointer under the property lock.
-- Confirm therefore always leaves a durable obligation; only a proven phone
-- suppression discharges it (suppression_retried_ok + clear, done by the app and
-- by the sweeper). fn_list_outstanding_suppression_obligations feeds the sweeper:
-- ledger rows older than a threshold with no retried_ok, for confirmed
-- opted_out/dnc reviews, in a rotating order so permanently failing rows cannot
-- starve the batch.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.fn_confirm_ai_disposition_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_review public.ai_disposition_reviews%rowtype;
  v_property record;
  v_new_revision bigint;
  v_keep_hold boolean;
begin
  if auth.uid() is null then
    raise exception 'signed-in user required'
      using errcode = '42501';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if not public.hugo_has_active_org_access(v_review.org_id) then
    raise exception 'active organization access required'
      using errcode = '42501';
  end if;

  select p.outreach_dispo, p.homeowner_contact_id, p.decision_context_revision,
         p.last_ai_escalation_reason
  into v_property
  from public.properties p
  where p.id = v_review.property_id
    and p.org_id = v_review.org_id
  for update;

  if not found then
    raise exception 'AI disposition review property not found'
      using errcode = 'P0002';
  end if;

  select review.*
  into v_review
  from public.ai_disposition_reviews review
  where review.id = p_review_id
  for update;

  if not found then
    raise exception 'AI disposition review not found'
      using errcode = 'P0002';
  end if;

  if v_review.status <> 'pending' then
    return jsonb_build_object(
      'status', v_review.status,
      'reviewId', v_review.id
    );
  end if;

  if not v_review.dispo_applied then
    if v_property.decision_context_revision is distinct from v_review.decision_context_revision
      or v_property.outreach_dispo is not null
    then
      update public.ai_disposition_reviews
      set status = 'superseded',
          resolved_at = now(),
          superseded_reason = 'property_outcome_changed'
      where id = v_review.id;

      insert into public.lead_events (
        org_id, property_id, actor_type, event_type, payload,
        source_type, source_id
      ) values (
        v_review.org_id, v_review.property_id, 'system', 'ai_dispo_review_superseded',
        jsonb_build_object(
          'review_id', v_review.id,
          'proposed_disposition', v_review.disposition,
          'replacement_disposition', v_property.outreach_dispo,
          'reason', 'property_outcome_changed',
          'source_inbound_message_id', v_review.source_inbound_message_id
        ),
        'ai_disposition_reviews.superseded', v_review.id
      )
      on conflict (source_type, source_id) where source_id is not null do nothing;

      return jsonb_build_object('status', 'superseded', 'reviewId', v_review.id);
    end if;

    update public.ai_disposition_reviews
    set status = 'confirmed',
        resolved_at = now(),
        reviewed_by = auth.uid(),
        dispo_applied = true
    where id = v_review.id;

    -- An existing suppression_incomplete pointer belongs to OTHER reviews whose
    -- phone suppression is still outstanding. Confirming this review must not
    -- drop it (nor the attention flag it drives); the merge below and the clear
    -- function decide, under this same lock, when it may go away.
    v_keep_hold := v_property.last_ai_escalation_reason is not null
      and (v_property.last_ai_escalation_reason = 'suppression_incomplete'
        or left(v_property.last_ai_escalation_reason, length('suppression_incomplete:')) = 'suppression_incomplete:');

    update public.properties
    set outreach_dispo = v_review.disposition,
        needs_human_attention = v_keep_hold,
        last_ai_escalation_reason = case when v_keep_hold then v_property.last_ai_escalation_reason else null end,
        updated_at = now()
    where id = v_review.property_id
      and org_id = v_review.org_id
    returning decision_context_revision into v_new_revision;

    update public.ai_disposition_reviews
    set decision_context_revision = v_new_revision
    where id = v_review.id;

    -- Fix: only opted_out/dnc suppress the contact/phone. not_interested
    -- and wrong_number confirm the property disposition but must never
    -- flip contacts.sms_opted_out.
    if v_review.disposition in ('opted_out', 'dnc')
      and v_property.homeowner_contact_id is not null
    then
      begin
        update public.contacts
        set sms_opted_out = true, sms_opted_out_at = now()
        where id = v_property.homeowner_contact_id
          and do_not_contact = false and sms_opted_out = false;
      exception when others then
        if sqlerrm not like 'DNC_LOCKED%' then
          raise;
        end if;
      end;
    end if;

    -- Durable obligation: phone-level suppression runs in the app AFTER this
    -- transaction commits. Record it here, atomically with the confirm, so a
    -- process death cannot lose it. Same row shape the app failure path writes.
    if v_review.disposition in ('opted_out', 'dnc') then
      insert into public.lead_events (
        org_id, property_id, actor_type, event_type, payload,
        source_type, source_id
      ) values (
        v_review.org_id, v_review.property_id, 'system', 'suppression_incomplete',
        jsonb_build_object('reviewId', v_review.id),
        'ai_disposition_reviews', v_review.id
      )
      on conflict (source_type, source_id) where source_id is not null do nothing;

      perform 1
      from public.fn_merge_suppression_incomplete_pointer(
        p_property_id => v_review.property_id,
        p_ids => array[v_review.id],
        p_hint_id => v_review.id
      );
    end if;

    insert into public.lead_events (
      org_id, property_id, actor_type, actor_id, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id,
      v_review.property_id,
      'user',
      auth.uid(),
      'ai_dispo_review_confirmed',
      jsonb_build_object(
        'review_id', v_review.id,
        'disposition', v_review.disposition,
        'source_inbound_message_id', v_review.source_inbound_message_id,
        'note', 'deferred dispo write applied at confirmation'
      ),
      'ai_disposition_reviews.confirmed',
      v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    return jsonb_build_object(
      'status', 'confirmed',
      'reviewId', v_review.id
    );
  end if;

  if v_property.outreach_dispo is distinct from v_review.disposition
    or v_property.decision_context_revision is distinct from v_review.decision_context_revision
  then
    update public.ai_disposition_reviews
    set status = 'superseded',
        resolved_at = now(),
        superseded_reason = 'property_outcome_changed'
    where id = v_review.id;

    insert into public.lead_events (
      org_id, property_id, actor_type, event_type, payload,
      source_type, source_id
    ) values (
      v_review.org_id,
      v_review.property_id,
      'system',
      'ai_dispo_review_superseded',
      jsonb_build_object(
        'review_id', v_review.id,
        'proposed_disposition', v_review.disposition,
        'replacement_disposition', v_property.outreach_dispo,
        'reason', 'property_outcome_changed',
        'source_inbound_message_id', v_review.source_inbound_message_id
      ),
      'ai_disposition_reviews.superseded',
      v_review.id
    )
    on conflict (source_type, source_id) where source_id is not null do nothing;

    return jsonb_build_object(
      'status', 'superseded',
      'reviewId', v_review.id
    );
  end if;

  update public.ai_disposition_reviews
  set status = 'confirmed',
      resolved_at = now(),
      reviewed_by = auth.uid()
  where id = v_review.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_review.org_id,
    v_review.property_id,
    'user',
    auth.uid(),
    'ai_dispo_review_confirmed',
    jsonb_build_object(
      'review_id', v_review.id,
      'disposition', v_review.disposition,
      'source_inbound_message_id', v_review.source_inbound_message_id
    ),
    'ai_disposition_reviews.confirmed',
    v_review.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'confirmed',
    'reviewId', v_review.id
  );
end;
$$;

-- Per-review attempt bookkeeping for the sweeper, kept in the database.
-- Written only on a FAILED sweeper attempt; success is the retried_ok ledger row.
create table if not exists public.suppression_obligation_attempts (
  review_id uuid primary key references public.ai_disposition_reviews(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  org_id uuid not null,
  attempt_count integer not null default 0,
  last_attempt_at timestamptz not null default now(),
  last_reported_at timestamptz
);
alter table public.suppression_obligation_attempts enable row level security;
revoke all on public.suppression_obligation_attempts from public, anon, authenticated;
grant all on public.suppression_obligation_attempts to service_role;

-- Backoff after n failed attempts: 2m, 10m, 1h, 6h, then daily.
create or replace function public.fn_suppression_retry_backoff(p_attempts integer)
returns interval
language sql
immutable
as $$
  select case
    when p_attempts <= 0 then interval '0'
    when p_attempts = 1 then interval '2 minutes'
    when p_attempts = 2 then interval '10 minutes'
    when p_attempts = 3 then interval '1 hour'
    when p_attempts = 4 then interval '6 hours'
    else interval '1 day'
  end;
$$;

-- Records one failed sweeper attempt. should_report is true at most once per
-- row per day, and only from the 3rd failed attempt on.
create or replace function public.fn_record_suppression_attempt_failure(
  p_review_id uuid,
  p_property_id uuid,
  p_org_id uuid
)
returns table(attempt_count integer, should_report boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer;
  v_reported timestamptz;
  v_report boolean;
begin
  insert into public.suppression_obligation_attempts as a
    (review_id, property_id, org_id, attempt_count, last_attempt_at)
  values (p_review_id, p_property_id, p_org_id, 1, now())
  on conflict (review_id) do update
    set attempt_count = a.attempt_count + 1,
        last_attempt_at = now()
  returning a.attempt_count, a.last_reported_at into v_count, v_reported;

  v_report := v_count >= 3 and (v_reported is null or v_reported < now() - interval '1 day');
  if v_report then
    update public.suppression_obligation_attempts
    set last_reported_at = now()
    where review_id = p_review_id;
  end if;
  return query select v_count, v_report;
end;
$$;

revoke all on function public.fn_record_suppression_attempt_failure(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_record_suppression_attempt_failure(uuid, uuid, uuid) to service_role;

create or replace function public.fn_list_outstanding_suppression_obligations(
  p_older_than_seconds integer default 120,
  p_limit integer default 25
)
returns table(review_id uuid, property_id uuid, org_id uuid, reviewed_by uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.id, r.property_id, r.org_id, r.reviewed_by
  from public.lead_events le
  join public.ai_disposition_reviews r on r.id = le.source_id
  left join public.suppression_obligation_attempts att on att.review_id = r.id
  where le.event_type = 'suppression_incomplete'
    and le.source_type = 'ai_disposition_reviews'
    and le.created_at < now() - make_interval(secs => greatest(p_older_than_seconds, 0))
    and r.status = 'confirmed'
    and r.disposition in ('opted_out', 'dnc')
    and (
      att.review_id is null
      or att.last_attempt_at + public.fn_suppression_retry_backoff(att.attempt_count) <= now()
    )
    and not exists (
      select 1 from public.lead_events ok
      where ok.event_type = 'suppression_retried_ok'
        and ok.source_type = 'ai_disposition_reviews.suppression_retried'
        and ok.source_id = le.source_id
    )
  -- Rotating order (changes every 10 minutes) so rows that keep failing cannot
  -- permanently occupy the front of a bounded batch.
  order by hashtext(r.id::text || (extract(epoch from now())::bigint / 600)::text), r.id
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on function public.fn_list_outstanding_suppression_obligations(integer, integer) from public, anon, authenticated;
grant execute on function public.fn_list_outstanding_suppression_obligations(integer, integer) to service_role;

-- Holds whose every pointer id already has a retried_ok and that have no live
-- failed ledger row: a clear that failed after the ok write. The sweeper calls
-- fn_clear_suppression_hold_if_resolved on these; the database still decides.
create index if not exists properties_suppression_hold_idx
  on public.properties (id)
  where left(last_ai_escalation_reason, 22) = 'suppression_incomplete';

create or replace function public.fn_list_resolvable_suppression_holds(p_limit integer default 25)
returns table(property_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id
  from public.properties p
  where left(p.last_ai_escalation_reason, 22) = 'suppression_incomplete'
    and not exists (
      select 1 from public.fn_suppression_ledger_state(p.id) s
      where s.ledger_failed and not s.resolved
    )
    and not exists (
      select 1
      from regexp_split_to_table(
        case when left(p.last_ai_escalation_reason, 23) = 'suppression_incomplete:'
             then substr(p.last_ai_escalation_reason, length('suppression_incomplete:') + 1)
             else '' end, ',') as x(raw)
      where case
              when trim(x.raw) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then not exists (
                select 1 from public.fn_suppression_ledger_state(p.id) s
                where s.review_id = trim(x.raw)::uuid and s.resolved
              )
              else false
            end
    )
  order by hashtext(p.id::text || (extract(epoch from now())::bigint / 600)::text), p.id
  limit least(greatest(p_limit, 1), 100);
$$;

revoke all on function public.fn_list_resolvable_suppression_holds(integer) from public, anon, authenticated;
grant execute on function public.fn_list_resolvable_suppression_holds(integer) to service_role;

notify pgrst, 'reload schema';

commit;
