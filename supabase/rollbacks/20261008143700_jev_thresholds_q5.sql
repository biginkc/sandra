-- Rollback for 20261008143700_jev_thresholds_q5. Restores not_interested to
-- 0.95 only where this migration set it (marker history row, and the row has
-- not been edited since: still 0.90 at that exact version). Owner edits made
-- after the migration are kept. Appends a history row; history is never
-- rewritten. Note: re-applying the migration afterwards does not re-move rows
-- (their version is now > 1), which is the safe direction.
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
    select t.id, t.org_id, t.version, t.min_confidence, t.automation_enabled
    from public.jev_outcome_thresholds t
    join public.jev_outcome_threshold_history h
      on h.org_id = t.org_id and h.outcome = t.outcome
     and h.idempotency_key = v_marker and h.version = t.version
    where t.outcome = 'not_interested'
      and t.min_confidence = 0.90
    for update of t
  loop
    v_new_version := r.version + 1;
    update public.jev_outcome_thresholds
    set min_confidence = 0.95, version = v_new_version, updated_at = statement_timestamp()
    where id = r.id;
    insert into public.jev_outcome_threshold_history (
      threshold_id, org_id, outcome, previous_min_confidence, new_min_confidence,
      previous_automation_enabled, new_automation_enabled,
      version, changed_by
    ) values (
      r.id, r.org_id, 'not_interested', 0.90, 0.95,
      r.automation_enabled, r.automation_enabled,
      v_new_version, null
    );
  end loop;
end $$;

do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, '(''not_interested'', 0.90)', '(''not_interested'', 0.95)');
  if v_new <> v_def then execute v_new; end if;
end $$;

commit;
