-- Rollback for 20261006100000_dialpad_ledger_keys_native_columns.
-- Only safe before any native row exists (2.4 writes 'dialpad-native:' keys and origin='native' intents):
-- the old predicates reject them, so this fails loudly instead of orphaning evidence. After native rows
-- exist, turn the consumer flags off (native_matcher, click_to_dial) and keep the schema.
-- The reverse patches put the literal back into the live bodies, again without re-typing them.
begin;

do $patch$
declare
  r record;
  v_def text;
  v_new text;
begin
  for r in select * from (values
    ('public.fn_get_acquisition_call_references(uuid,uuid,uuid)',
      'public.dialpad_cti_is_ledger_key(provider_attempt_key)', 'provider_attempt_key like ''dialpad-cti:%'''),
    ('public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)',
      'public.dialpad_cti_is_ledger_key(provider_attempt_key)', 'provider_attempt_key like ''dialpad-cti:%'''),
    ('public.fn_open_dialpad_recording_capture(uuid,uuid,uuid)',
      'public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)', '''dialpad-cti:'' || v_intent.id::text'),
    ('public.fn_get_dialpad_call_status(uuid,uuid,uuid)',
      'public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)', '''dialpad-cti:'' || v_intent.id::text'),
    ('public.dialpad_cti_project_intent(uuid)',
      'public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)', '''dialpad-cti:'' || v_intent.id::text'),
    ('public.dialpad_cti_project_intent(uuid)',
      'public.dialpad_cti_is_ledger_key(jitter_attempt_id)', 'jitter_attempt_id like ''dialpad-cti:%'''),
    ('public.fn_dialpad_recording_library_sources(uuid,text)',
      'public.dialpad_cti_intent_key(i.origin,i.id,i.matched_provider_call_id)', '''dialpad-cti:''||i.id::text'),
    ('public.fn_dialpad_recording_playback_file(uuid,text,text)',
      'public.dialpad_cti_intent_key(i.origin,i.id,i.matched_provider_call_id)', '''dialpad-cti:''||i.id::text'),
    ('public.my_leads_link_backfill_candidates(uuid)',
      'public.dialpad_cti_intent_key(i.origin, i.id, i.matched_provider_call_id)', '''dialpad-cti:'' || i.id::text')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    if position(r.anchor in v_def) = 0 then continue; end if;
    v_new := replace(v_def, r.anchor, r.repl);
    execute v_new;
  end loop;
end $patch$;

create unique index if not exists idx_call_activities_org_dialpad_cti_attempt
  on public.call_activities (org_id, jitter_attempt_id)
  where provider = 'dialpad' and jitter_attempt_id like 'dialpad-cti:%';
create unique index if not exists idx_call_activities_org_dialpad_cti_call
  on public.call_activities (org_id, provider_call_id)
  where provider = 'dialpad' and jitter_attempt_id like 'dialpad-cti:%' and provider_call_id is not null;
drop index if exists public.idx_call_activities_org_dialpad_ledger_attempt;
drop index if exists public.idx_call_activities_org_dialpad_ledger_call;

alter table public.acquisition_attempts drop constraint if exists acquisition_attempts_pending_outcome_check;
alter table public.acquisition_attempts add constraint acquisition_attempts_pending_outcome_check check (
  source = 'sandra'
  or outcome is not null
  or (source = 'dialpad' and coalesce(provider_attempt_key like 'dialpad-cti:%', false))
);

drop function if exists public.dialpad_cti_is_ledger_key(text);
drop function if exists public.dialpad_cti_intent_key(text, uuid, text);
alter table public.dialpad_call_intents drop constraint if exists dialpad_call_intents_origin_check;
alter table public.dialpad_call_intents drop constraint if exists dialpad_call_intents_direction_check;
alter table public.dialpad_call_intents drop column if exists origin, drop column if exists direction;

commit;
