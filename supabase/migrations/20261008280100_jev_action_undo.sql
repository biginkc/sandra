-- 20261008280100_jev_action_undo.sql
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
  paused_enrollment_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references auth.users(id) on delete set null,
  constraint jev_action_undo_undone_pair
    check ((undone_at is null) = (undone_by is null) or undone_at is not null)
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

  select p.outreach_dispo into v_current
  from public.properties p
  where p.id = v_undo.property_id and p.org_id = v_undo.org_id
  for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_current is distinct from v_undo.applied_dispo then
    -- A person (or a later decision) changed it since: never overwrite that.
    raise exception 'STATE_CHANGED' using errcode = '40001';
  end if;

  update public.properties
  set outreach_dispo = v_undo.prior_outreach_dispo,
      follow_up_at = v_undo.prior_follow_up_at,
      updated_at = now()
  where id = v_undo.property_id and org_id = v_undo.org_id;

  update public.ai_disposition_reviews
  set status = 'superseded',
      resolved_at = now(),
      reviewed_by = null,
      superseded_reason = 'jev_action_undone'
  where source_inbound_message_id = v_undo.source_inbound_message_id
    and org_id = v_undo.org_id
    and status = 'confirmed';

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
