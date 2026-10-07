-- Suppression pointer merge v2: ledger-backed ids no longer occupy pointer slots.
--
-- v1 (20261008143900) kept every existing pointer id and appended hints, so ten
-- ordinary failures whose ledger writes SUCCEEDED filled the 10-slot cap and the
-- next genuinely UNBACKED id (one that exists nowhere but the pointer) was
-- dropped: a confirmed opt-out with nothing on the banner after one DB failure.
--
-- v2 (new signature; the v1 signature is dropped), under `for update`:
--   * p_backed_ids: ids the caller just wrote/backfilled into the ledger. They
--     are removed from the existing pointer list before merging.
--   * p_unbacked_ids: ids that exist nowhere else. Existing (still-unbacked)
--     ids keep their order, then p_unbacked_ids are appended.
--   * p_hint_id is used only when the resulting list would otherwise be empty
--     (pointer = [hint]); it never competes with an unbacked id for a slot.
--   * cap 10 applies after that ordering; dropped_ids is therefore non-empty
--     only when more than 10 UNBACKED ids exist.
--   * a current send-timeout reason with no unbacked ids passed is kept (hold
--     only), as in v1.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

drop function if exists public.fn_merge_suppression_incomplete_pointer(uuid, uuid[], text[], uuid);

create or replace function public.fn_merge_suppression_incomplete_pointer(
  p_property_id uuid,
  p_unbacked_ids uuid[],
  p_backed_ids uuid[],
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
  v_existing uuid[] := '{}';
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

  if v_current is not null then
    foreach v_prefix in array coalesce(p_timeout_prefixes, '{}') loop
      if left(v_current, length(v_prefix)) = v_prefix then
        v_is_timeout := true;
      end if;
    end loop;
  end if;

  if v_is_timeout and coalesce(cardinality(p_unbacked_ids), 0) = 0 then
    update public.properties
    set needs_human_attention = true, updated_at = now()
    where id = p_property_id;
    return query select v_current, '{}'::uuid[], true, '{}'::uuid[];
    return;
  end if;

  if v_current is not null and left(v_current, length('suppression_incomplete:')) = 'suppression_incomplete:' then
    for v_raw in
      select trim(x) from unnest(string_to_array(substr(v_current, length('suppression_incomplete:') + 1), ',')) as x
    loop
      if v_raw <> '' and v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        v_id := v_raw::uuid;
        -- Ledger-backed ids no longer need a pointer slot.
        if not (v_id = any(coalesce(p_backed_ids, '{}'))) and not (v_id = any(v_existing)) then
          v_existing := v_existing || v_id;
        end if;
      end if;
    end loop;
  end if;

  v_all := v_existing;
  foreach v_id in array coalesce(p_unbacked_ids, '{}') loop
    if not (v_id = any(v_all)) then
      v_all := v_all || v_id;
    end if;
  end loop;

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
    -- Nothing to point at: just raise the hold.
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

revoke all on function public.fn_merge_suppression_incomplete_pointer(uuid, uuid[], uuid[], text[], uuid) from public, anon, authenticated;
grant execute on function public.fn_merge_suppression_incomplete_pointer(uuid, uuid[], uuid[], text[], uuid) to service_role;

commit;
