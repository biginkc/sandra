-- Rollback for 20261006100100_dialpad_intent_timeout.
-- Removes the sweep function and the failed rule/state; the nullable failed_at column stays (audit of
-- intents already marked). Remove the cron call to fn_fail_stale_dialpad_intents first.
begin;
drop function if exists public.fn_fail_stale_dialpad_intents(integer, integer);
do $patch$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
    ('public.dialpad_cti_guard_intent()',
      E'  if new.failed_at is distinct from old.failed_at\n     and (old.failed_at is not null or new.failed_at is null or old.dispatch_authorized_at is null or old.status <> ''prepared'') then\n    raise exception ''failed marker is set once, on a dispatched prepared intent'' using errcode = ''42501'';\n  end if;\n', ''),
    ('public.dialpad_cti_guard_intent()', ', ''dispatch_authorized_at'', ''failed_at'']', ', ''dispatch_authorized_at'']'),
    ('public.dialpad_cti_guard_intent()', ' or new.failed_at is not null then', ' then'),
    ('public.fn_get_dialpad_call_status(uuid,uuid,uuid)', 'when v_intent.failed_at is not null then ''failed'' when v_intent.expires_at', 'when v_intent.expires_at'),
    ('public.fn_get_dialpad_call_status(uuid,uuid,uuid)', '''failedAt'', v_intent.failed_at,', '')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    if position(r.anchor in v_def) = 0 then continue; end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $patch$;
commit;
