-- My Leads unified work queue, Phase B1: "Call today" without a midnight expiry, and Dismiss on
-- a Broken row. Design v8 sections 2, 2.1 and 6.
--
--   * my_leads_strip_overrides: a pin may now have a null pinned_until when pinned_at is set.
--     The check used to demand exactly one of pinned_until / hidden_until. Old (expiring) pins and
--     "Not today" rows are still valid; the old page reads `pinned_until > now`, so a no-expiry
--     pin is simply ignored by the flag-off page (null > now is not true).
--   * fn_set_my_leads_strip_override (flag-off page): body unchanged except its expired-row
--     cleanup now skips rows with no expiry, so a no-expiry pin can never be swept away.
--   * fn_set_my_leads_pin: pin / clear, no expiry, member-only, same scope checks as the old RPC.
--     Used only by the unified page.
--   * fn_dismiss_my_leads_broken: member-only "Dismiss" on a Broken row. Appends the lead_events
--     row `rep_sms_failure_dismissed` (actor_type user, source_id = the ledger / obligation /
--     message id) that the classifier reads, idempotently. The source id must belong to the same
--     org and lead in one of the classifier's Broken sources, else NOT_FOUND (P0002).
-- No data step. No existing row changes meaning.
begin;

alter table public.my_leads_strip_overrides drop constraint my_leads_strip_overrides_one_kind_check;
alter table public.my_leads_strip_overrides add constraint my_leads_strip_overrides_one_kind_check
  check (
    -- expiring pin or hide: exactly one expiry, pin timestamp present iff it is a pin
    (num_nonnulls(pinned_until, hidden_until) = 1 and ((pinned_until is null) = (pinned_at is null)))
    -- no-expiry pin (Call today, unified queue): pinned_at set, no expiry of either kind
    or (pinned_at is not null and pinned_until is null and hidden_until is null));

create or replace function public.fn_set_my_leads_strip_override(p_org_id uuid, p_member_id uuid, p_property_id uuid, p_action text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
  v_midnight timestamptz;
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if auth.uid() is distinct from p_member_id then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_property_id is null or p_action is null or p_action not in ('call_today', 'not_today', 'clear') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.my_leads_queue_rows_for(p_org_id, p_member_id, v_now, p_property_id) r
                 where r.property_id = p_property_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  v_midnight := public.my_leads_next_chicago_midnight(v_now);
  -- Expired rows only: a no-expiry pin (both expiries null) is never swept here.
  delete from public.my_leads_strip_overrides o
   where o.org_id = p_org_id and o.member_id = p_member_id
     and (o.pinned_until is not null or o.hidden_until is not null)
     and coalesce(o.pinned_until, o.hidden_until) <= v_now;
  if p_action = 'call_today' then
    insert into public.my_leads_strip_overrides(org_id, member_id, property_id, pinned_at, pinned_until, hidden_until, updated_at)
    values (p_org_id, p_member_id, p_property_id, v_now, v_midnight, null, v_now)
    on conflict (org_id, member_id, property_id) do update
      set pinned_at = excluded.pinned_at, pinned_until = excluded.pinned_until, hidden_until = null, updated_at = v_now;
  elsif p_action = 'not_today' then
    insert into public.my_leads_strip_overrides(org_id, member_id, property_id, pinned_at, pinned_until, hidden_until, updated_at)
    values (p_org_id, p_member_id, p_property_id, null, null, v_midnight, v_now)
    on conflict (org_id, member_id, property_id) do update
      set pinned_at = null, pinned_until = null, hidden_until = excluded.hidden_until, updated_at = v_now;
  else
    delete from public.my_leads_strip_overrides o
     where o.org_id = p_org_id and o.member_id = p_member_id and o.property_id = p_property_id;
  end if;
  return jsonb_build_object('ok', true, 'until', case when p_action = 'clear' then null else v_midnight end);
end;
$$;
revoke all on function public.fn_set_my_leads_strip_override(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.fn_set_my_leads_strip_override(uuid, uuid, uuid, text) to authenticated;

-- Call today for the unified queue: no midnight expiry. 'pin' stamps pinned_at = now with no
-- expiry; 'clear' is the Undo. The pin ends by itself when a call is logged after pinned_at (the
-- classifier's read predicate), so there is nothing to sweep.
create or replace function public.fn_set_my_leads_pin(p_org_id uuid, p_member_id uuid, p_property_id uuid, p_action text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if auth.uid() is distinct from p_member_id then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_property_id is null or p_action is null or p_action not in ('pin', 'clear') then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.my_leads_queue_rows_for(p_org_id, p_member_id, v_now, p_property_id) r
                 where r.property_id = p_property_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  if p_action = 'pin' then
    insert into public.my_leads_strip_overrides(org_id, member_id, property_id, pinned_at, pinned_until, hidden_until, updated_at)
    values (p_org_id, p_member_id, p_property_id, v_now, null, null, v_now)
    on conflict (org_id, member_id, property_id) do update
      set pinned_at = excluded.pinned_at, pinned_until = null, hidden_until = null, updated_at = v_now;
  else
    delete from public.my_leads_strip_overrides o
     where o.org_id = p_org_id and o.member_id = p_member_id and o.property_id = p_property_id;
  end if;
  return jsonb_build_object('ok', true, 'pinnedAt', case when p_action = 'pin' then v_now end);
end;
$$;
revoke all on function public.fn_set_my_leads_pin(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.fn_set_my_leads_pin(uuid, uuid, uuid, text) to authenticated;

-- Dismiss on a Broken row. p_source_id is the id the classifier reported in the row's broken[]
-- item (ledger / obligation / message / enrollment id); the classifier suppresses the item whose
-- refId equals a rep_sms_failure_dismissed event's source_id. Repeating a dismissal is a no-op.
create or replace function public.fn_dismiss_my_leads_broken(p_org_id uuid, p_member_id uuid, p_property_id uuid, p_source_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_now timestamptz := statement_timestamp();
begin
  perform public.my_leads_require_read_scope(p_org_id, p_member_id);
  if auth.uid() is distinct from p_member_id then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_property_id is null or p_source_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  if not exists (select 1 from public.my_leads_queue_rows_for(p_org_id, p_member_id, v_now, p_property_id) r
                 where r.property_id = p_property_id) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  -- The id must be a Broken source of THIS lead in THIS org (ledger, obligation, message by property
  -- or by the homeowner contact, AI dead letter, or drip enrollment); otherwise a member could plant a
  -- dismissal row for an arbitrary id.
  if not (
    exists (select 1 from public.rep_sms_delivery_ledger x where x.id = p_source_id and x.org_id = p_org_id and x.property_id = p_property_id)
    or exists (select 1 from public.rep_sms_obligations x where x.id = p_source_id and x.org_id = p_org_id and x.property_id = p_property_id)
    or exists (select 1 from public.messages x
               where x.id = p_source_id and x.org_id = p_org_id
                 and (x.property_id = p_property_id
                      or (x.property_id is null and x.contact_id is not null
                          and x.contact_id = (select p.homeowner_contact_id from public.properties p where p.id = p_property_id and p.org_id = p_org_id))))
    or exists (select 1 from public.ai_reply_dead_letters x where x.id = p_source_id and x.org_id = p_org_id and x.property_id = p_property_id)
    or exists (select 1 from public.sequence_enrollments x where x.id = p_source_id and x.org_id = p_org_id and x.property_id = p_property_id)
  ) then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  insert into public.lead_events(org_id, property_id, actor_type, actor_id, event_type, payload, source_type, source_id)
  values (p_org_id, p_property_id, 'user', p_member_id, 'rep_sms_failure_dismissed', '{}'::jsonb, 'rep_sms_failure_dismissal', p_source_id)
  on conflict (source_type, source_id) where source_id is not null do nothing;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.fn_dismiss_my_leads_broken(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function public.fn_dismiss_my_leads_broken(uuid, uuid, uuid, uuid) to authenticated;

commit;
