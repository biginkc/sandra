-- 20261008150200_hold_resolve_stale_guard_and_alert_sending.sql
-- Messages v2 Phase 1 review round 1. Patches forward from 20261008150100.
--
-- 1. fn_resolve_hold (Dismiss / Take over) is now version-aware. The card sends
--    what it displayed: the newest pending hold row's created_at
--    (p_seen_through) and the flag's reason / time (p_flag_reason, p_flag_at).
--    If anything is pending that is newer than that, or the flag changed, the
--    function changes NOTHING and returns {"status":"STALE"}: a hold created
--    after the page loaded is never wiped by a stale click. Every update is
--    also filtered to created_at <= p_seen_through, so a row inserted while the
--    function runs is left alone even though the check passed.
-- 2. Send and Dismiss cannot interleave: the function takes the same lease
--    table the send path uses (ai_send_reservations), keyed by the property id,
--    for the duration of its transaction. A Send holding the lease makes the
--    function raise SEND_IN_PROGRESS; a Send arriving while the function runs
--    waits on the row, then re-reads the draft and finds it discarded.
-- 3. The function reports responderChanged and flagCleared so the audit trail
--    only logs state that really changed.
-- 4. hold_alert_deliveries.status gains 'sending' (+ sending_at). A delivery is
--    marked 'sending' BEFORE the provider call, so a crash mid-send leaves a row
--    that is never resent (see the sweep in the alert pass).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1-3. fn_resolve_hold
-- ---------------------------------------------------------------------------
drop function if exists public.fn_resolve_hold(uuid, uuid, uuid, text, text);

create or replace function public.fn_resolve_hold(
  p_org_id uuid,
  p_property_id uuid,
  p_user_id uuid,
  p_action text,
  p_reason text default null,
  p_seen_through timestamptz default null,
  p_flag_reason text default null,
  p_flag_at timestamptz default null
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
  v_flag_cleared boolean := false;
  v_responder_changed boolean := false;
  v_superseded_reason text;
  v_cutoff timestamptz := coalesce(p_seen_through, '-infinity'::timestamptz);
  v_leased boolean;
  v_newer boolean;
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

  select p.id, p.org_id, p.needs_human_attention, p.ai_responder_disabled,
         p.last_ai_escalation_reason, p.last_ai_escalation_at
    into v_property
  from public.properties p
  where p.id = p_property_id
  for update;
  if not found or v_property.org_id <> p_org_id then
    raise exception 'PROPERTY_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The per-property lease (same table the send path leases from). Held until
  -- this transaction ends: the delete at the bottom rolls back with it on error.
  insert into public.ai_send_reservations as r (
    conversation_id, holder, inbound_message_id, expires_at, created_at
  ) values (
    p_property_id, 'resolve_hold:' || p_user_id::text, null,
    clock_timestamp() + interval '60 seconds', clock_timestamp()
  )
  on conflict (conversation_id) do update
    set holder = excluded.holder,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    where r.expires_at <= clock_timestamp();
  get diagnostics v_leased = row_count;
  if not v_leased then
    raise exception 'SEND_IN_PROGRESS' using errcode = '55P03';
  end if;

  -- Stale view: anything pending that the card did not display, or a flag that
  -- is no longer the one it displayed.
  v_newer :=
    exists (select 1 from public.jev_lead_decisions d
            where d.property_id = p_property_id and d.org_id = p_org_id
              and d.status = 'pending' and d.created_at > v_cutoff)
    or exists (select 1 from public.ai_disposition_reviews r2
               where r2.property_id = p_property_id and r2.org_id = p_org_id
                 and r2.status = 'pending' and r2.created_at > v_cutoff)
    or exists (select 1 from public.ai_reply_drafts x
               where x.property_id = p_property_id and x.org_id = p_org_id
                 and x.status = 'pending' and x.created_at > v_cutoff)
    or (
      v_property.needs_human_attention
      and (
        v_property.last_ai_escalation_reason is distinct from p_flag_reason
        or v_property.last_ai_escalation_at is distinct from p_flag_at
      )
    );
  if v_newer then
    delete from public.ai_send_reservations
    where conversation_id = p_property_id and holder = 'resolve_hold:' || p_user_id::text;
    return jsonb_build_object('status', 'STALE', 'action', p_action);
  end if;

  v_superseded_reason := case p_action when 'dismiss' then 'hold_dismissed' else 'hold_taken_over' end;

  update public.jev_lead_decisions d
  set status = 'superseded',
      resolved_at = now(),
      superseded_reason = v_superseded_reason
  where d.property_id = p_property_id
    and d.org_id = p_org_id
    and d.status = 'pending'
    and d.created_at <= v_cutoff;
  get diagnostics v_decisions = row_count;

  update public.ai_disposition_reviews r
  set status = 'superseded',
      resolved_at = now(),
      superseded_reason = v_superseded_reason
  where r.property_id = p_property_id
    and r.org_id = p_org_id
    and r.status = 'pending'
    and r.created_at <= v_cutoff;
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
    and x.status = 'pending'
    and x.created_at <= v_cutoff;
  get diagnostics v_drafts = row_count;

  -- The flag is cleared only if it is still the one the card displayed (the
  -- check above already refused a changed flag; this repeats it in the WHERE so
  -- the guard is part of the write itself).
  update public.properties p
  set needs_human_attention = false,
      last_ai_escalation_reason = null,
      last_ai_escalation_at = null,
      updated_at = now()
  where p.id = p_property_id
    and p.needs_human_attention
    and p.last_ai_escalation_reason is not distinct from p_flag_reason
    and p.last_ai_escalation_at is not distinct from p_flag_at;
  v_flag_cleared := found;

  if p_action = 'take_over' and not v_property.ai_responder_disabled then
    update public.properties p
    set ai_responder_disabled = true, updated_at = now()
    where p.id = p_property_id;
    v_responder_changed := true;
  end if;
  v_cleared := v_flag_cleared or v_responder_changed;

  delete from public.ai_send_reservations
  where conversation_id = p_property_id and holder = 'resolve_hold:' || p_user_id::text;

  return jsonb_build_object(
    'status', 'OK',
    'action', p_action,
    'decisionsSuperseded', v_decisions,
    'reviewsSuperseded', v_reviews,
    'draftsDiscarded', v_drafts,
    'propertyUpdated', v_cleared,
    'flagCleared', v_flag_cleared,
    'responderChanged', v_responder_changed,
    'wasFlagged', v_property.needs_human_attention
  );
end;
$$;

revoke all on function public.fn_resolve_hold(uuid, uuid, uuid, text, text, timestamptz, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_resolve_hold(uuid, uuid, uuid, text, text, timestamptz, text, timestamptz)
  to service_role;

comment on function public.fn_resolve_hold(uuid, uuid, uuid, text, text, timestamptz, text, timestamptz) is
  'Messages v2: Dismiss / Take over a hold atomically and version-aware (returns status STALE and changes nothing when the card is out of date). Leases the property against a concurrent Send. Service role only; re-checks owner||acquisitions for p_user_id.';

-- ---------------------------------------------------------------------------
-- 4. hold_alert_deliveries: 'sending'
-- ---------------------------------------------------------------------------
alter table public.hold_alert_deliveries
  add column if not exists sending_at timestamptz;

alter table public.hold_alert_deliveries
  drop constraint if exists hold_alert_deliveries_status_check;
alter table public.hold_alert_deliveries
  add constraint hold_alert_deliveries_status_check
  check (status in ('pending', 'sending', 'sent', 'failed', 'skipped'));

comment on column public.hold_alert_deliveries.sending_at is
  'Set when a delivery is claimed (status sending), before the provider call. A sending row older than the cron maxDuration is swept to failed:interrupted and never resent.';

commit;
