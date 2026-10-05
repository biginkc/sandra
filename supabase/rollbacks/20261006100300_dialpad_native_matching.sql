-- Rollback for 20261006100300_dialpad_native_matching.
-- Native intents already created stay valid evidence (intents are immutable). The connection stays disabled
-- until 2.11, so none exist before activation; after that, turn native_matcher off instead of rolling back.
begin;

do $patch$
declare
  r record;
  v_def text;
begin
  for r in select * from (values
    ('public.dialpad_cti_project_intent(uuid)',
      'v_events, v_intent.direction, v_intent.destination_e164,', 'v_events, ''outbound'', v_intent.destination_e164,'),
    ('public.dialpad_cti_project_intent(uuid)',
      'if not v_property.is_training and v_intent.direction = ''outbound'' then', 'if not v_property.is_training then'),
    ('public.fn_process_dialpad_call_event(uuid)',
      ', ''outside_intent_window'', ''ambiguous_lead'')', ', ''outside_intent_window'')')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    if position(r.anchor in v_def) = 0 then continue; end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $patch$;

do $restore$
begin
  if to_regprocedure('public.dialpad_cti_resolve_event_legacy(uuid)') is not null then
    drop function if exists public.dialpad_cti_resolve_event(uuid);
    alter function public.dialpad_cti_resolve_event_legacy(uuid) rename to dialpad_cti_resolve_event;
  end if;
end $restore$;

drop function if exists public.dialpad_cti_native_resolve(uuid);
drop function if exists public.dialpad_cti_native_bind(uuid, uuid, uuid, uuid, smallint);
drop function if exists public.dialpad_cti_native_candidates(uuid, uuid, text);

commit;
