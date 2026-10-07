-- Suppression recovery: the database is the single source of truth.
--
-- v2 (20261008144000) trusted the caller's backed/unbacked classification, which
-- came from the latest ledger-insert ATTEMPT: ten durable ledger-backed ids on
-- the pointer plus a failed insert and failed backfills dropped the new id. The
-- retry action also read "outstanding" and then cleared by reason equality, so a
-- failure recorded between that read and the clear could be wiped.
--
-- Here both decisions are made inside the database under the property row lock:
--   * fn_merge_suppression_incomplete_pointer(p_property_id, p_ids, ...) : the
--     caller reports every id it knows about; the function itself prunes ids
--     that have a live ledger row (lead_events 'suppression_incomplete' with no
--     later 'suppression_retried_ok'), caps the TRULY unbacked ids at 10.
--   * fn_clear_suppression_hold_if_resolved(p_property_id) : recomputes
--     outstanding = pointer ids U ledger failures (minus retried_ok) under the
--     same lock and clears the hold only when that set is empty.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function if exists public.fn_merge_suppression_incomplete_pointer(uuid, uuid[], uuid[], text[], uuid);

-- Internal: per-review ledger state for a property.
--   ledger_failed: a 'suppression_incomplete' ledger row exists.
--   resolved: a 'suppression_retried_ok' row exists at or after the failure.
create or replace function public.fn_suppression_ledger_state(p_property_id uuid)
returns table(review_id uuid, ledger_failed boolean, resolved boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with f as (
    select le.source_id, max(le.created_at) as ts
    from public.lead_events le
    where le.property_id = p_property_id
      and le.event_type = 'suppression_incomplete'
      and le.source_type = 'ai_disposition_reviews'
      and le.source_id is not null
    group by le.source_id
  ), o as (
    select le.source_id, max(le.created_at) as ts
    from public.lead_events le
    where le.property_id = p_property_id
      and le.event_type = 'suppression_retried_ok'
      and le.source_id is not null
    group by le.source_id
  )
  select coalesce(f.source_id, o.source_id),
         f.source_id is not null,
         (o.ts is not null and o.ts >= coalesce(f.ts, '-infinity'::timestamptz))
  from f full join o on o.source_id = f.source_id;
$$;

revoke all on function public.fn_suppression_ledger_state(uuid) from public, anon, authenticated;
grant execute on function public.fn_suppression_ledger_state(uuid) to service_role;

create or replace function public.fn_merge_suppression_incomplete_pointer(
  p_property_id uuid,
  p_ids uuid[],
  p_timeout_prefixes text[] default array['send_timeout:', 'dead_letter_failed:send_timeout:'],
  p_hint_id uuid default null
)
returns table(reason text, merged_ids uuid[], kept_timeout boolean, dropped_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current text;
  v_backed uuid[];
  v_all uuid[] := '{}';
  v_id uuid;
  v_prefix text;
  v_is_timeout boolean := false;
  v_final uuid[];
  v_dropped uuid[];
  v_reason text;
  v_raw text;
begin
  select p.last_ai_escalation_reason into v_current
  from public.properties p
  where p.id = p_property_id
  for update;

  if not found then
    raise exception 'property not found' using errcode = 'P0002';
  end if;

  -- Ledger-backed ids (live failure row) never need a pointer slot.
  select coalesce(array_agg(s.review_id), '{}') into v_backed
  from public.fn_suppression_ledger_state(p_property_id) s
  where s.ledger_failed and not s.resolved;

  if v_current is not null then
    foreach v_prefix in array coalesce(p_timeout_prefixes, '{}') loop
      if left(v_current, length(v_prefix)) = v_prefix then
        v_is_timeout := true;
      end if;
    end loop;
  end if;

  -- Existing pointer ids first (oldest kept), then the caller's ids.
  if v_current is not null and left(v_current, length('suppression_incomplete:')) = 'suppression_incomplete:' then
    for v_raw in
      select trim(x) from unnest(string_to_array(substr(v_current, length('suppression_incomplete:') + 1), ',')) as x
    loop
      if v_raw <> '' and v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_id := v_raw::uuid;
        if not (v_id = any(v_backed)) and not (v_id = any(v_all)) then
          v_all := v_all || v_id;
        end if;
      end if;
    end loop;
  end if;
  foreach v_id in array coalesce(p_ids, '{}') loop
    if not (v_id = any(v_backed)) and not (v_id = any(v_all)) then
      v_all := v_all || v_id;
    end if;
  end loop;

  if v_is_timeout and cardinality(v_all) = 0 then
    update public.properties
    set needs_human_attention = true, updated_at = now()
    where id = p_property_id;
    return query select v_current, '{}'::uuid[], true, '{}'::uuid[];
    return;
  end if;

  if cardinality(v_all) = 0 and p_hint_id is not null then
    v_all := array[p_hint_id];
  end if;

  if cardinality(v_all) > 10 then
    v_final := v_all[1:10];
    v_dropped := v_all[11:cardinality(v_all)];
  else
    v_final := v_all;
    v_dropped := '{}';
  end if;

  if cardinality(v_final) = 0 then
    update public.properties
    set needs_human_attention = true, updated_at = now()
    where id = p_property_id;
    return query select v_current, '{}'::uuid[], false, '{}'::uuid[];
    return;
  end if;

  select 'suppression_incomplete:' || string_agg(i::text, ',' order by ord)
  into v_reason
  from unnest(v_final) with ordinality as t(i, ord);

  update public.properties
  set last_ai_escalation_reason = v_reason,
      last_ai_escalation_at = now(),
      needs_human_attention = true,
      updated_at = now()
  where id = p_property_id;

  return query select v_reason, v_final, false, v_dropped;
end;
$$;

revoke all on function public.fn_merge_suppression_incomplete_pointer(uuid, uuid[], text[], uuid) from public, anon, authenticated;
grant execute on function public.fn_merge_suppression_incomplete_pointer(uuid, uuid[], text[], uuid) to service_role;

create or replace function public.fn_clear_suppression_hold_if_resolved(p_property_id uuid)
returns table(cleared boolean, outstanding_ids uuid[])
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_current text;
  v_is_hold boolean;
  v_pointer uuid[] := '{}';
  v_out uuid[] := '{}';
  v_ordered uuid[];
  v_id uuid;
  v_raw text;
  v_reason text;
begin
  select p.last_ai_escalation_reason into v_current
  from public.properties p
  where p.id = p_property_id
  for update;

  if not found then
    raise exception 'property not found' using errcode = 'P0002';
  end if;

  v_is_hold := v_current is not null
    and (v_current = 'suppression_incomplete' or left(v_current, length('suppression_incomplete:')) = 'suppression_incomplete:');

  if v_current is not null and left(v_current, length('suppression_incomplete:')) = 'suppression_incomplete:' then
    for v_raw in
      select trim(x) from unnest(string_to_array(substr(v_current, length('suppression_incomplete:') + 1), ',')) as x
    loop
      if v_raw <> '' and v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_id := v_raw::uuid;
        if not (v_id = any(v_pointer)) then
          v_pointer := v_pointer || v_id;
        end if;
      end if;
    end loop;
  end if;

  -- outstanding = pointer ids U ledger failures, minus anything retried_ok.
  -- Pointer-only (unbacked) ids first so a rewrite can never drop them.
  select coalesce(array_agg(x.id order by x.grp, x.ord), '{}') into v_out
  from (
    select pt.id, 0 as grp, pt.ord
    from unnest(v_pointer) with ordinality as pt(id, ord)
    where not exists (
      select 1 from public.fn_suppression_ledger_state(p_property_id) s
      where s.review_id = pt.id and s.ledger_failed
    )
    and not exists (
      select 1 from public.fn_suppression_ledger_state(p_property_id) s
      where s.review_id = pt.id and s.resolved
    )
    union all
    select s.review_id, 1, row_number() over (order by s.review_id)
    from public.fn_suppression_ledger_state(p_property_id) s
    where s.ledger_failed and not s.resolved
  ) x;

  if not v_is_hold then
    -- Timeout / other reasons are never cleared here.
    return query select false, v_out;
    return;
  end if;

  if cardinality(v_out) = 0 then
    update public.properties
    set needs_human_attention = false,
        last_ai_escalation_reason = null,
        last_ai_escalation_at = null,
        updated_at = now()
    where id = p_property_id;
    return query select true, '{}'::uuid[];
    return;
  end if;

  v_ordered := v_out[1:least(cardinality(v_out), 10)];
  select 'suppression_incomplete:' || string_agg(i::text, ',' order by ord)
  into v_reason
  from unnest(v_ordered) with ordinality as t(i, ord);
  if v_reason is distinct from v_current then
    update public.properties
    set last_ai_escalation_reason = v_reason,
        updated_at = now()
    where id = p_property_id;
  end if;
  return query select false, v_out;
end;
$$;

revoke all on function public.fn_clear_suppression_hold_if_resolved(uuid) from public, anon, authenticated;
grant execute on function public.fn_clear_suppression_hold_if_resolved(uuid) to service_role;

commit;
