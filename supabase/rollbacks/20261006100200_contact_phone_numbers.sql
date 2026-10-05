-- Rollback for 20261006100200_contact_phone_numbers.
-- Data layer first: roll back every applied phone_backfill run (fn_my_leads_housekeeping_rollback / the
-- script's `rollback --run`) BEFORE this; afterwards such a run can no longer be rolled back. Safe until
-- 2.4 (native matching) depends on the table: undo 2.4 first.
-- The rollback entry point and fingerprint get the phone_backfill hunks cut back out of the live bodies.
begin;

drop trigger if exists contact_phone_numbers_sync_insert on public.contacts;
drop trigger if exists contact_phone_numbers_sync_update on public.contacts;

do $patch$
declare
  v_def text;
  v_from int;
  v_to int;
begin
  v_def := pg_get_functiondef('public.my_leads_housekeeping_rollback_fingerprint(uuid,uuid)'::regprocedure);
  v_from := position(E'          when ''contact_phone_numbers'' then (' in v_def);
  v_to := position(E'          when ''acquisition_assignment_episodes'' then' in v_def);
  if v_from > 0 and v_to > v_from then
    execute substr(v_def, 1, v_from - 1) || substr(v_def, v_to);
  end if;

  v_def := pg_get_functiondef('public.fn_my_leads_housekeeping_rollback(uuid,uuid,text)'::regprocedure);
  v_from := position(E'  perform 1 from public.contact_phone_numbers cpn\n' in v_def);
  v_to := position(E'  perform 1 from public.acquisition_appointment_attribution aa\n' in v_def);
  if v_from > 0 and v_to > v_from then
    v_def := substr(v_def, 1, v_from - 1) || substr(v_def, v_to);
  end if;
  v_from := position(E'  elsif v_run.kind = ''phone_backfill'' then\n' in v_def);
  v_to := position(E'  else\n    raise exception ''ROLLBACK_UNSUPPORTED' in v_def);
  if v_from > 0 and v_to > v_from then
    v_def := substr(v_def, 1, v_from - 1) || substr(v_def, v_to);
  end if;
  execute v_def;
end $patch$;

drop function if exists public.fn_contact_phone_numbers_backfill(uuid, boolean, text);
drop function if exists public.my_leads_phone_backfill_candidates(uuid);
drop function if exists public.contact_phone_numbers_sync();
drop table if exists public.contact_phone_numbers;

commit;
