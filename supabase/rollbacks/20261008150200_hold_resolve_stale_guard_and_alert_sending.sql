-- Rollback for 20261008150200. Restores the 5-argument fn_resolve_hold from
-- 20261008150100 and the original status check. 'sending' rows are folded into
-- 'failed' first so the old constraint holds.
begin;

update public.hold_alert_deliveries
  set status = 'failed', attempts = greatest(attempts, 3), last_error = coalesce(last_error, 'interrupted')
  where status = 'sending';

alter table public.hold_alert_deliveries
  drop constraint if exists hold_alert_deliveries_status_check;
alter table public.hold_alert_deliveries
  add constraint hold_alert_deliveries_status_check
  check (status in ('pending', 'sent', 'failed', 'skipped'));
alter table public.hold_alert_deliveries drop column if exists sending_at;

drop function if exists public.fn_resolve_hold(uuid, uuid, uuid, text, text, timestamptz, text, timestamptz);

create or replace function public.fn_resolve_hold(
  p_org_id uuid,
  p_property_id uuid,
  p_user_id uuid,
  p_action text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_property record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_decisions integer := 0;
  v_reviews integer := 0;
  v_drafts integer := 0;
  v_cleared boolean := false;
  v_superseded_reason text;
begin
  if p_action not in ('dismiss', 'take_over') then
    raise exception 'INVALID_HOLD_ACTION' using errcode = '22023';
  end if;
  if p_action = 'dismiss' and v_reason is null then
    raise exception 'REASON_REQUIRED' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from public.memberships m
    where m.user_id = p_user_id
      and m.org_id = p_org_id
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > now())
      and (m.role = 'owner' or m.acquisitions_enabled = true)
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  select p.id, p.org_id, p.needs_human_attention
    into v_property
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found or v_property.org_id <> p_org_id then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_superseded_reason := case p_action when 'dismiss' then 'hold_dismissed' else 'hold_taken_over' end;

  update public.jev_lead_decisions d
  set status = 'superseded',
      resolved_at = now(),
      superseded_reason = v_superseded_reason
  where d.property_id = p_property_id
    and d.org_id = p_org_id
    and d.status = 'pending';
  get diagnostics v_decisions = row_count;

  update public.ai_disposition_reviews r
  set status = 'superseded',
      resolved_at = now(),
      superseded_reason = v_superseded_reason
  where r.property_id = p_property_id
    and r.org_id = p_org_id
    and r.status = 'pending';
  get diagnostics v_reviews = row_count;

  update public.ai_reply_drafts x
  set status = 'discarded',
      resolved_by = p_user_id,
      resolved_at = now(),
      resolution_reason = case p_action
        when 'dismiss' then 'dismissed: ' || v_reason
        else 'taken_over'
      end
  where x.property_id = p_property_id
    and x.org_id = p_org_id
    and x.status = 'pending';
  get diagnostics v_drafts = row_count;

  update public.properties p
  set needs_human_attention = false,
      last_ai_escalation_reason = null,
      last_ai_escalation_at = null,
      ai_responder_disabled = case when p_action = 'take_over' then true else p.ai_responder_disabled end,
      updated_at = now()
  where p.id = p_property_id
    and (
      p.needs_human_attention
      or (p_action = 'take_over' and not p.ai_responder_disabled)
    );
  v_cleared := found;

  return jsonb_build_object(
    'action', p_action,
    'decisionsSuperseded', v_decisions,
    'reviewsSuperseded', v_reviews,
    'draftsDiscarded', v_drafts,
    'propertyUpdated', v_cleared,
    'wasFlagged', v_property.needs_human_attention
  );
end;
$$;

revoke all on function public.fn_resolve_hold(uuid, uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_resolve_hold(uuid, uuid, uuid, text, text) to service_role;

comment on function public.fn_resolve_hold(uuid, uuid, uuid, text, text) is
  'Messages v2: Dismiss / Take over a hold atomically. Service role only; re-checks owner||acquisitions for p_user_id.';

commit;
