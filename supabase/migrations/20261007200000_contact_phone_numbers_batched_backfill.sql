-- My Leads one-call close, P2 (2.3 follow-up): batched phone backfill and rollback.
--
-- Why: fn_contact_phone_numbers_backfill (20261006100200) computes the whole org in one statement. On
-- prod (363k contacts, ~484k phone slots to fill) the preview alone runs past the 8s API statement
-- timeout, so the housekeeping run could never be previewed, and a one-shot apply or rollback of ~484k
-- rows cannot fit either. A function-level `set statement_timeout` does not help: the timer for the
-- running API statement is already armed. So the work is split into keyset-paged ranges of contacts and
-- driven by scripts/my-leads-housekeeping.mjs, one API call (one transaction) per range.
--
-- Contract (same shape as the one-shot function, per range):
--   * preview range: read-only; returns counts, a digest of the range's candidate rows, the last contact
--     id of the range, and up to 20 sample contact ids (ids only, never a number).
--   * apply range: takes the org advisory lock, locks the range's candidate contacts in id order,
--     recomputes the range digest under those locks and raises FINGERPRINT_MISMATCH (writing nothing for
--     that range) unless it equals the preview digest; images each row first (op 'created' / 'updated'),
--     then writes. All ranges of one apply share one run (the first non-empty range creates it).
--   * the script folds every range digest into ONE fingerprint that the confirm hash covers.
--   * rollback range / finish: same row-by-row restore rules as the one-shot branch, paged over the run's
--     before-images; the run flips to rolled_back only when nothing was left unrestored.
-- The applied migration is untouched; the one-shot function stays but the script no longer calls it.
-- NO data step: this file only defines functions.
begin;

create or replace function public.my_leads_phone_backfill_range_candidates(p_org_id uuid, p_after uuid, p_upto uuid)
returns table (contact_id uuid, slot smallint, e164 text, existing_e164 text, existing_updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, s.slot::smallint, s.norm, n.e164, n.updated_at
  from public.contacts c
  cross join lateral (
    select v.slot, public.dialpad_cti_normalize_us_phone(v.phone) as norm
    from (values (1, c.phone_1), (2, c.phone_2), (3, c.phone_3)) as v(slot, phone)
  ) s
  left join public.contact_phone_numbers n on n.contact_id = c.id and n.slot = s.slot::smallint and n.org_id = p_org_id
  where c.org_id = p_org_id
    and (p_after is null or c.id > p_after)
    and c.id <= p_upto
    and s.norm is not null
    and n.e164 is distinct from s.norm
$$;
revoke all on function public.my_leads_phone_backfill_range_candidates(uuid, uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.fn_contact_phone_numbers_backfill_range(
  p_org_id uuid,
  p_after uuid default null,
  p_limit int default 2000,
  p_upto uuid default null,
  p_apply boolean default false,
  p_expected_digest text default null,
  p_run uuid default null,
  p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_upto uuid;
  v_count int;
  v_created int;
  v_updated int;
  v_digest text;
  v_sample jsonb;
  v_result jsonb;
  v_run uuid;
  v_now timestamptz;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;
  if p_apply then
    if p_upto is null then
      raise exception 'INVALID_INPUT: apply needs the range end from the preview' using errcode = 'P0001';
    end if;
    if p_expected_digest is null then
      raise exception 'FINGERPRINT_REQUIRED: apply needs the range digest from the preview' using errcode = 'P0001';
    end if;
    v_upto := p_upto;
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    perform 1 from public.contacts c
    where c.org_id = p_org_id
      and c.id in (select k.contact_id from public.my_leads_phone_backfill_range_candidates(p_org_id, p_after, v_upto) k)
    order by c.id for update;
  else
    if p_limit is null or p_limit < 1 or p_limit > 5000 then
      raise exception 'INVALID_INPUT: limit must be between 1 and 5000' using errcode = 'P0001';
    end if;
    select r.id into v_upto from (
      select c.id from public.contacts c
      where c.org_id = p_org_id and (p_after is null or c.id > p_after)
      order by c.id limit p_limit) r
    order by r.id desc limit 1;
    if v_upto is null then
      return jsonb_build_object('kind', 'phone_backfill_range', 'done', true, 'lastId', null,
        'candidates', 0, 'toCreate', 0, 'toUpdate', 0, 'digest', null, 'sample', '[]'::jsonb);
    end if;
  end if;

  select count(*)::int,
         (count(*) filter (where k.existing_e164 is null))::int,
         (count(*) filter (where k.existing_e164 is not null))::int,
         encode(sha256(convert_to('phone_backfill|' || coalesce(string_agg(
           k.contact_id::text || ':' || k.slot::text || ':' || k.e164 || ':' || coalesce(k.existing_e164, ''),
           ',' order by k.contact_id, k.slot), ''), 'utf8')), 'hex')
  into v_count, v_created, v_updated, v_digest
  from public.my_leads_phone_backfill_range_candidates(p_org_id, p_after, v_upto) k;

  if not p_apply then
    select coalesce(jsonb_agg(u.x order by u.x), '[]'::jsonb) into v_sample from (
      select distinct k.contact_id::text as x
      from public.my_leads_phone_backfill_range_candidates(p_org_id, p_after, v_upto) k order by 1 limit 20) u;
    return jsonb_build_object('kind', 'phone_backfill_range', 'done', false, 'lastId', v_upto,
      'candidates', v_count, 'toCreate', v_created, 'toUpdate', v_updated, 'digest', v_digest, 'sample', v_sample);
  end if;

  if p_expected_digest is distinct from v_digest then
    raise exception 'FINGERPRINT_MISMATCH: the cohort changed since the preview; run a new preview' using errcode = 'P0001';
  end if;
  if v_count = 0 then
    return jsonb_build_object('kind', 'phone_backfill_range', 'noop', true, 'runId', p_run,
      'candidates', 0, 'created', 0, 'updated', 0);
  end if;

  if p_run is null then
    insert into public.my_leads_housekeeping_runs (org_id, kind, params, created_at)
    values (p_org_id, 'phone_backfill', jsonb_build_object('fingerprint', p_fingerprint, 'batched', true), clock_timestamp())
    returning id into v_run;
  else
    select r.id into v_run from public.my_leads_housekeeping_runs r
    where r.id = p_run and r.org_id = p_org_id and r.kind = 'phone_backfill' and r.status = 'applied' for update;
    if v_run is null then
      raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
    end if;
  end if;

  v_now := clock_timestamp();
  insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
  select v_run, 'contact_phone_numbers', md5(k.contact_id::text || ':' || k.slot::text)::uuid,
         case when k.existing_e164 is null
           then jsonb_build_object('op', 'created', 'contact_id', k.contact_id, 'slot', k.slot,
                                   'applied_e164', k.e164, 'applied_updated_at', v_now)
           else jsonb_build_object('op', 'updated', 'contact_id', k.contact_id, 'slot', k.slot,
                                   'e164', k.existing_e164, 'updated_at', k.existing_updated_at,
                                   'applied_e164', k.e164, 'applied_updated_at', v_now)
         end
  from public.my_leads_phone_backfill_range_candidates(p_org_id, p_after, v_upto) k;

  insert into public.contact_phone_numbers as n (contact_id, slot, org_id, e164, updated_at)
  select k.contact_id, k.slot, p_org_id, k.e164, v_now
  from public.my_leads_phone_backfill_range_candidates(p_org_id, p_after, v_upto) k
  on conflict (contact_id, slot) do update set e164 = excluded.e164, updated_at = excluded.updated_at;

  update public.my_leads_housekeeping_runs
  set summary = jsonb_build_object(
    'created', coalesce((summary ->> 'created')::int, 0) + v_created,
    'updated', coalesce((summary ->> 'updated')::int, 0) + v_updated)
  where id = v_run and org_id = p_org_id;
  v_result := jsonb_build_object('kind', 'phone_backfill_range', 'runId', v_run,
    'candidates', v_count, 'created', v_created, 'updated', v_updated);
  return v_result;
end $$;
revoke all on function public.fn_contact_phone_numbers_backfill_range(uuid, uuid, int, uuid, boolean, text, uuid, text) from public, anon, authenticated;
grant execute on function public.fn_contact_phone_numbers_backfill_range(uuid, uuid, int, uuid, boolean, text, uuid, text) to service_role;

-- Cheap run description for the operator script (the generic run info fingerprints every before-image
-- in one statement, which is the same timeout again for a run this size).
create or replace function public.fn_contact_phone_numbers_backfill_run_info(p_run uuid, p_org_id uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.my_leads_housekeeping_runs%rowtype;
begin
  perform public.my_leads_housekeeping_require_service();
  select * into v_run from public.my_leads_housekeeping_runs where id = p_run and org_id = p_org_id;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
  end if;
  return jsonb_build_object('kind', 'rollback', 'run', jsonb_build_object(
    'id', v_run.id, 'orgId', v_run.org_id, 'kind', v_run.kind, 'status', v_run.status,
    'params', v_run.params, 'summary', v_run.summary, 'createdAt', v_run.created_at));
end $$;
revoke all on function public.fn_contact_phone_numbers_backfill_run_info(uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_contact_phone_numbers_backfill_run_info(uuid, uuid) to service_role;

-- Rollback, one range of before-images at a time (ordered by row_id). Preview returns the range digest
-- (the current state of every row the range would touch); apply locks those rows, recomputes it, and
-- restores row by row under the same rules as the one-shot branch: a row goes back only while it still
-- equals what the run wrote; a created row is removed only if no native call references its contact;
-- anything else is reported in notRestored, never forced.
create or replace function public.fn_contact_phone_numbers_backfill_rollback_range(
  p_run uuid,
  p_org_id uuid,
  p_after uuid default null,
  p_limit int default 2000,
  p_upto uuid default null,
  p_apply boolean default false,
  p_expected_digest text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_run public.my_leads_housekeeping_runs%rowtype;
  v_upto uuid;
  v_digest text;
  v_images int;
  r record;
  v_cur record;
  v_rows int;
  v_restored int := 0;
  v_already int := 0;
  v_not_restored jsonb := '[]'::jsonb;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;
  select * into v_run from public.my_leads_housekeeping_runs where id = p_run and org_id = p_org_id;
  if not found or v_run.kind <> 'phone_backfill' then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
  end if;
  if v_run.status = 'rolled_back' then
    return jsonb_build_object('runId', p_run, 'noop', true, 'status', 'rolled_back', 'done', true);
  end if;

  if p_apply then
    if p_upto is null then
      raise exception 'INVALID_INPUT: apply needs the range end from the preview' using errcode = 'P0001';
    end if;
    if p_expected_digest is null then
      raise exception 'FINGERPRINT_REQUIRED: rollback needs the range digest from the preview' using errcode = 'P0001';
    end if;
    v_upto := p_upto;
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    perform 1 from public.my_leads_housekeeping_runs where id = p_run and org_id = p_org_id for update;
    perform 1 from public.contact_phone_numbers n
    where n.org_id = p_org_id and (n.contact_id, n.slot) in (
      select (b.before ->> 'contact_id')::uuid, (b.before ->> 'slot')::smallint
      from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'contact_phone_numbers'
        and (p_after is null or b.row_id > p_after) and b.row_id <= v_upto)
    order by n.contact_id, n.slot for update;
  else
    if p_limit is null or p_limit < 1 or p_limit > 5000 then
      raise exception 'INVALID_INPUT: limit must be between 1 and 5000' using errcode = 'P0001';
    end if;
    select x.row_id into v_upto from (
      select b.row_id from public.my_leads_housekeeping_before_images b
      where b.run_id = p_run and b.table_name = 'contact_phone_numbers' and (p_after is null or b.row_id > p_after)
      order by b.row_id limit p_limit) x
    order by x.row_id desc limit 1;
    if v_upto is null then
      return jsonb_build_object('kind', 'phone_backfill_rollback_range', 'done', true, 'lastId', null, 'images', 0, 'digest', null);
    end if;
  end if;

  select count(*)::int,
         encode(sha256(convert_to('phone_backfill_rollback|' || coalesce(string_agg(
           b.row_id::text || ':' || coalesce(n.e164 || '/' || n.updated_at::text, ''), ',' order by b.row_id), ''), 'utf8')), 'hex')
  into v_images, v_digest
  from public.my_leads_housekeeping_before_images b
  left join public.contact_phone_numbers n
    on n.contact_id = (b.before ->> 'contact_id')::uuid and n.slot = (b.before ->> 'slot')::smallint and n.org_id = p_org_id
  where b.run_id = p_run and b.table_name = 'contact_phone_numbers'
    and (p_after is null or b.row_id > p_after) and b.row_id <= v_upto;

  if not p_apply then
    return jsonb_build_object('kind', 'phone_backfill_rollback_range', 'done', false, 'lastId', v_upto,
      'images', v_images, 'digest', v_digest);
  end if;
  if p_expected_digest is distinct from v_digest then
    raise exception 'FINGERPRINT_MISMATCH: the run state changed since the preview; run a new preview' using errcode = 'P0001';
  end if;

  for r in
    select b.row_id, b.before from public.my_leads_housekeeping_before_images b
    where b.run_id = p_run and b.table_name = 'contact_phone_numbers'
      and (p_after is null or b.row_id > p_after) and b.row_id <= v_upto
    order by b.row_id
  loop
    begin
      select n.e164, n.updated_at into v_cur from public.contact_phone_numbers n
      where n.contact_id = (r.before ->> 'contact_id')::uuid and n.slot = (r.before ->> 'slot')::smallint
        and n.org_id = p_org_id;
      if not found then
        if r.before ->> 'op' = 'created' then
          v_already := v_already + 1;
          continue;
        end if;
        raise exception 'ROW_MISSING' using errcode = 'P0001';
      end if;
      if r.before ->> 'op' = 'updated' and v_cur.e164 is not distinct from (r.before ->> 'e164')
         and v_cur.updated_at is not distinct from (r.before ->> 'updated_at')::timestamptz then
        v_already := v_already + 1;
        continue;
      end if;
      if v_cur.e164 is distinct from (r.before ->> 'applied_e164')
         or v_cur.updated_at is distinct from (r.before ->> 'applied_updated_at')::timestamptz then
        raise exception 'CHANGED_SINCE' using errcode = 'P0001';
      end if;
      if r.before ->> 'op' = 'created' then
        if exists (select 1 from public.dialpad_call_intents i
                   where i.org_id = p_org_id and i.origin = 'native'
                     and i.contact_id = (r.before ->> 'contact_id')::uuid) then
          raise exception 'NATIVE_CALL_REFERENCES' using errcode = 'P0001';
        end if;
        delete from public.contact_phone_numbers n
        where n.contact_id = (r.before ->> 'contact_id')::uuid and n.slot = (r.before ->> 'slot')::smallint
          and n.org_id = p_org_id and n.e164 = (r.before ->> 'applied_e164')
          and n.updated_at = (r.before ->> 'applied_updated_at')::timestamptz;
      else
        update public.contact_phone_numbers n
        set e164 = r.before ->> 'e164', updated_at = (r.before ->> 'updated_at')::timestamptz
        where n.contact_id = (r.before ->> 'contact_id')::uuid and n.slot = (r.before ->> 'slot')::smallint
          and n.org_id = p_org_id and n.e164 = (r.before ->> 'applied_e164')
          and n.updated_at = (r.before ->> 'applied_updated_at')::timestamptz;
      end if;
      get diagnostics v_rows = row_count;
      if v_rows <> 1 then
        raise exception 'ROW_CHANGED' using errcode = 'P0001';
      end if;
      v_restored := v_restored + 1;
    exception when others then
      v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(
        'contact', r.before ->> 'contact_id', 'slot', r.before ->> 'slot', 'reason', sqlerrm, 'code', sqlstate));
    end;
  end loop;
  return jsonb_build_object('kind', 'phone_backfill_rollback_range', 'runId', p_run, 'lastId', v_upto,
    'images', v_images, 'restored', v_restored, 'alreadyRestored', v_already, 'notRestored', v_not_restored);
end $$;
revoke all on function public.fn_contact_phone_numbers_backfill_rollback_range(uuid, uuid, uuid, int, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_contact_phone_numbers_backfill_rollback_range(uuid, uuid, uuid, int, uuid, boolean, text) to service_role;

-- Closes a batched rollback: the run flips to rolled_back only when no range left a row unrestored.
create or replace function public.fn_contact_phone_numbers_backfill_rollback_finish(
  p_run uuid, p_org_id uuid, p_restored int, p_already int, p_not_restored jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_summary jsonb;
  v_clean boolean;
begin
  perform public.my_leads_housekeeping_require_service();
  perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
  perform 1 from public.my_leads_housekeeping_runs
  where id = p_run and org_id = p_org_id and kind = 'phone_backfill' for update;
  if not found then
    raise exception 'RUN_NOT_FOUND' using errcode = 'P0001';
  end if;
  v_clean := jsonb_array_length(coalesce(p_not_restored, '[]'::jsonb)) = 0;
  v_summary := jsonb_build_object('restored', coalesce(p_restored, 0), 'alreadyRestored', coalesce(p_already, 0),
    'notRestored', coalesce(p_not_restored, '[]'::jsonb));
  update public.my_leads_housekeeping_runs
  set status = case when v_clean then 'rolled_back' else status end,
      rolled_back_at = case when v_clean then now() else rolled_back_at end,
      summary = summary || jsonb_build_object('rollback', v_summary)
  where id = p_run and org_id = p_org_id;
  return jsonb_build_object('runId', p_run, 'status', case when v_clean then 'rolled_back' else 'applied' end) || v_summary;
end $$;
revoke all on function public.fn_contact_phone_numbers_backfill_rollback_finish(uuid, uuid, int, int, jsonb) from public, anon, authenticated;
grant execute on function public.fn_contact_phone_numbers_backfill_rollback_finish(uuid, uuid, int, int, jsonb) to service_role;

commit;
