-- Roll back 20261015020100_my_leads_pin_no_expiry.
-- Removes the new RPCs, deletes any no-expiry pins (they cannot exist under the old check), restores
-- the original check constraint and the original flag-off override function body.
begin;

drop function if exists public.fn_dismiss_my_leads_broken(uuid, uuid, uuid, uuid);
drop function if exists public.fn_set_my_leads_pin(uuid, uuid, uuid, text);

delete from public.my_leads_strip_overrides where pinned_until is null and hidden_until is null;
alter table public.my_leads_strip_overrides drop constraint my_leads_strip_overrides_one_kind_check;
alter table public.my_leads_strip_overrides add constraint my_leads_strip_overrides_one_kind_check
  check (num_nonnulls(pinned_until, hidden_until) = 1 and ((pinned_until is null) = (pinned_at is null)));

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
  delete from public.my_leads_strip_overrides o
   where o.org_id = p_org_id and o.member_id = p_member_id
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

commit;
