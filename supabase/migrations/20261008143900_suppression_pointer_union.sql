-- Atomic merge of the suppression_incomplete hold pointer.
--
-- The pointer (properties.last_ai_escalation_reason = 'suppression_incomplete:a,b,c')
-- is a hint carrying review ids whose ledger write did not land. Concurrent
-- failures used to merge client-side (read, merge, conditional write) and a
-- final-attempt overwrite could drop another failure's id. This function does
-- the merge under a row lock so concurrent callers serialize and union.
--
-- Rules (under `for update` on the property row):
--   * current reason starts with a timeout prefix AND no unbacked ids were
--     passed (p_ids empty): the timeout flag is a different, still-open
--     problem and the caller already ledgered its ids -> only set
--     needs_human_attention, kept_timeout = true.
--   * otherwise: union the pointer's existing ids (order preserved) with
--     p_ids, then p_hint_id (the review that triggered the call, when it is
--     ledger-backed), cap at 10 oldest (extras returned in dropped_ids), and
--     write the pointer. Passing unbacked ids overrides a timeout reason on
--     purpose: those ids exist nowhere else.
-- Idempotent: re-running with the same ids yields the same pointer.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

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

  if v_is_timeout and coalesce(cardinality(p_ids), 0) = 0 then
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
        if not (v_id = any(v_existing)) then
          v_existing := v_existing || v_id;
        end if;
      end if;
    end loop;
  end if;

  v_all := v_existing;
  foreach v_id in array coalesce(p_ids, '{}') || case when p_hint_id is null then '{}'::uuid[] else array[p_hint_id] end loop
    if not (v_id = any(v_all)) then
      v_all := v_all || v_id;
    end if;
  end loop;

  if cardinality(v_all) > 10 then
    v_final := v_all[1:10];
    v_dropped := v_all[11:cardinality(v_all)];
  else
    v_final := v_all;
    v_dropped := '{}';
  end if;

  if cardinality(v_final) = 0 then
    -- Nothing to point at (no ids at all): just raise the hold.
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

commit;
