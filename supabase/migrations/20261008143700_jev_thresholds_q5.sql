-- Q5 thresholds (PLAN section 8 Q5, approved by Jarrad): not_interested
-- 0.95 -> 0.90. Every other outcome already matches the approved table
-- (new_lead 0.90 / automation off; wrong_number 0.90; nurture 0.95;
-- opted_out 0.95; automation on for the other four).
--
-- Only rows still at the untouched seed (0.95, version 1, never edited by a
-- human: updated_by is null) move. An owner-set value, including an owner who
-- re-saved 0.95, has version > 1 and is left alone.
--
-- fn_set_jev_outcome_threshold needs auth.uid() and an owner membership, so a
-- migration cannot call it; this writes the same two rows it would (version
-- bump + history row) with changed_by null (system). The history row carries a
-- fixed idempotency_key so the rollback can recognise rows this migration set
-- and a replay can never double-write.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare
  v_marker constant uuid := '00000000-0000-4000-8000-000000143700';
  r record;
  v_new_version integer;
begin
  for r in
    select id, org_id, version, min_confidence, automation_enabled
    from public.jev_outcome_thresholds
    where outcome = 'not_interested'
      and min_confidence = 0.95
      and version = 1
      and updated_by is null
    for update
  loop
    if exists (
      select 1 from public.jev_outcome_threshold_history h
      where h.org_id = r.org_id and h.outcome = 'not_interested'
        and h.idempotency_key = v_marker
    ) then
      continue;
    end if;
    v_new_version := r.version + 1;
    update public.jev_outcome_thresholds
    set min_confidence = 0.90,
        version = v_new_version,
        updated_at = statement_timestamp()
    where id = r.id;
    insert into public.jev_outcome_threshold_history (
      threshold_id, org_id, outcome, previous_min_confidence, new_min_confidence,
      previous_automation_enabled, new_automation_enabled,
      version, changed_by, idempotency_key
    ) values (
      r.id, r.org_id, 'not_interested', r.min_confidence, 0.90,
      r.automation_enabled, r.automation_enabled,
      v_new_version, null, v_marker
    );
  end loop;
end $$;

-- Fresh orgs / test resets seed not_interested at 0.90.
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  if position('(''not_interested'', 0.90)' in v_def) > 0 then
    return;
  end if;
  v_new := replace(v_def, '(''not_interested'', 0.95)', '(''not_interested'', 0.90)');
  if v_new = v_def then raise exception 'reset_tenant_tables q5 patch not applied'; end if;
  execute v_new;
end $$;

commit;
