-- 20261008300100_jev_action_undo.sql
-- Jarrad (2026-10-07, verbatim): "Jev shouldn't be making any actions that are
-- irreversible."
--
-- When Jev auto-applies wrong_number / not_interested / nurture, the app records
-- what it changed (prior outreach_dispo, prior follow_up_at, and the sequence
-- enrollments Jev's own action paused) in jev_action_undo. fn_undo_jev_action
-- restores the disposition and follow_up_at in one transaction; the caller then
-- resumes the returned enrollment ids through resume_sequence_enrollment.
--
-- Written only by service_role (dispatch). Read by active org members. Undo is
-- refused when a human changed the disposition since (STATE_CHANGED).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- 'undone' is a valid resolution for a nurture decision a person reversed. Every
-- value allowed since 20261008140300 (incl. opted_out/dnc for human corrections)
-- is kept; only 'undone' is appended.
alter table public.jev_lead_decisions
  drop constraint if exists jev_lead_decisions_resolved_outcome_check;
alter table public.jev_lead_decisions
  add constraint jev_lead_decisions_resolved_outcome_check
  check (resolved_outcome is null or resolved_outcome in
    ('new_lead', 'nurture', 'wrong_number', 'not_interested', 'opted_out', 'dnc', 'undone'));

create table if not exists public.jev_action_undo (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  property_id uuid not null references public.properties(id) on delete cascade,
  source_inbound_message_id uuid not null references public.messages(id) on delete cascade,
  classification_run_id uuid,
  action text not null check (action in ('wrong_number', 'not_interested', 'nurture')),
  applied_dispo text not null,
  prior_outreach_dispo text,
  prior_follow_up_at timestamptz,
  applied_follow_up_at timestamptz,
  recorded_revision bigint,
  paused_enrollment_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  -- undone_by may go null later (user deleted, on delete set null), but an
  -- actor can never be recorded without a timestamp.
  constraint jev_action_undo_undone_pair
    check (undone_by is null or undone_at is not null)
);
comment on table public.jev_action_undo is
  'Prior state captured when Jev auto-applied a reversible action, so a human can undo it from the Messages v2 live feed.';

create unique index if not exists idx_jev_action_undo_source_message
  on public.jev_action_undo (source_inbound_message_id);
create index if not exists idx_jev_action_undo_property
  on public.jev_action_undo (property_id, created_at desc);

alter table public.jev_action_undo enable row level security;
revoke all on public.jev_action_undo from public, anon, authenticated;
grant select on public.jev_action_undo to authenticated;
grant select, insert, update on public.jev_action_undo to service_role;

drop policy if exists jev_action_undo_org_select on public.jev_action_undo;
create policy jev_action_undo_org_select on public.jev_action_undo
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

create or replace function public.fn_undo_jev_action(p_undo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_undo public.jev_action_undo%rowtype;
  v_current text;
  v_current_follow timestamptz;
  v_decision_id uuid;
  v_review_id uuid;
  v_revision bigint;
  v_contact_id uuid;
  v_phones text[];
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_undo_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select * into v_undo from public.jev_action_undo where id = p_undo_id for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if not public.hugo_has_active_org_access(v_undo.org_id)
     or v_undo.org_id not in (select public.pipeline_runs_readable_org_ids()) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if v_undo.undone_at is not null then
    return jsonb_build_object('status', 'already_undone', 'enrollmentIds', '[]'::jsonb);
  end if;

  select p.outreach_dispo, p.follow_up_at, p.decision_context_revision, p.homeowner_contact_id
  into v_current, v_current_follow, v_revision, v_contact_id
  from public.properties p
  where p.id = v_undo.property_id and p.org_id = v_undo.org_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_current is distinct from v_undo.applied_dispo
     or v_current_follow is distinct from v_undo.applied_follow_up_at then
    -- A person (or a later decision) changed the disposition or the follow-up
    -- date since: never overwrite that.
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  -- Something decision-relevant happened since (newer inbound text, status or
  -- disposition write, booked appointment): a person must look at it again.
  if v_undo.recorded_revision is not null and v_revision is distinct from v_undo.recorded_revision then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  -- A person already confirmed Jev's decision: that is a human decision now.
  if exists (
    select 1 from public.ai_disposition_reviews r
    where r.source_inbound_message_id = v_undo.source_inbound_message_id
      and r.org_id = v_undo.org_id and r.status = 'confirmed' and r.reviewed_by is not null
  ) or exists (
    select 1 from public.jev_lead_decisions d
    where d.source_inbound_message_id = v_undo.source_inbound_message_id
      and d.org_id = v_undo.org_id and d.status = 'confirmed' and d.resolved_by is not null
  ) then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  -- Never undo into a state where the number is opted out / suppressed.
  if v_contact_id is not null and exists (
    select 1 from public.contacts c
    where c.id = v_contact_id and (c.sms_opted_out or c.do_not_contact)
  ) then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;
  select array_remove(array[
           (select m.from_address from public.messages m where m.id = v_undo.source_inbound_message_id),
           c.phone_1, c.phone_2, c.phone_3], null)
  into v_phones
  from (select 1) one
  left join public.contacts c on c.id = v_contact_id;
  if coalesce(cardinality(v_phones), 0) > 0 and exists (
    select 1 from public.sms_phone_suppressions sp
    where sp.org_id = v_undo.org_id and sp.channel = 'sms' and sp.phone_e164 = any(v_phones)
  ) then
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  update public.properties
  set outreach_dispo = v_undo.prior_outreach_dispo,
      follow_up_at = v_undo.prior_follow_up_at,
      updated_at = now()
  where id = v_undo.property_id and org_id = v_undo.org_id;

  -- Make the scorecard count the undo as a disagreement with Jev.
  if v_undo.action = 'nurture' then
    select d.id into v_decision_id
    from public.jev_lead_decisions d
    where d.source_inbound_message_id = v_undo.source_inbound_message_id
      and d.org_id = v_undo.org_id and d.status = 'confirmed'
    for update;
    if v_decision_id is not null then
      update public.jev_lead_decisions
      set status = 'corrected',
          resolved_outcome = 'undone',
          resolved_at = now(),
          resolved_by = v_actor,
          resolution_reason = 'undone from Messages v2'
      where id = v_decision_id;
      insert into public.lead_events (
        org_id, property_id, actor_type, actor_id, event_type, payload
      ) values (
        v_undo.org_id, v_undo.property_id, 'user', v_actor,
        'jev_lead_decision_corrected',
        jsonb_build_object(
          'decision_id', v_decision_id,
          'proposed_outcome', 'nurture',
          'previous_resolved_outcome', 'nurture',
          'corrected_outcome', 'undone',
          'reason', 'undone from Messages v2'
        )
      );
    end if;
  else
    select r.id into v_review_id
    from public.ai_disposition_reviews r
    where r.source_inbound_message_id = v_undo.source_inbound_message_id
      and r.org_id = v_undo.org_id;
    if v_review_id is not null then
      insert into public.lead_events (
        org_id, property_id, actor_type, actor_id, event_type, payload
      ) values (
        v_undo.org_id, v_undo.property_id, 'user', v_actor,
        'ai_disposition_review_corrected',
        jsonb_build_object(
          'review_id', v_review_id,
          'previous_disposition', v_undo.applied_dispo,
          'corrected_disposition', 'undone',
          'reason', 'undone from Messages v2'
        )
      );
    end if;
  end if;

  update public.jev_action_undo
  set undone_at = now(), undone_by = v_actor
  where id = v_undo.id;

  insert into public.lead_events (
    org_id, property_id, actor_type, actor_id, event_type, payload,
    source_type, source_id
  ) values (
    v_undo.org_id, v_undo.property_id, 'user', v_actor, 'jev_action_undone',
    jsonb_build_object(
      'action', v_undo.action,
      'applied_dispo', v_undo.applied_dispo,
      'restored_dispo', v_undo.prior_outreach_dispo,
      'restored_follow_up_at', v_undo.prior_follow_up_at,
      'source_inbound_message_id', v_undo.source_inbound_message_id
    ),
    'jev_action_undo', v_undo.id
  )
  on conflict (source_type, source_id) where source_id is not null do nothing;

  return jsonb_build_object(
    'status', 'undone',
    'propertyId', v_undo.property_id,
    'enrollmentIds', to_jsonb(v_undo.paused_enrollment_ids)
  );
end;
$$;

revoke all on function public.fn_undo_jev_action(uuid) from public, anon, service_role;
grant execute on function public.fn_undo_jev_action(uuid) to authenticated;

commit;
