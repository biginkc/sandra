-- Roll back 20261021130000: puts errcode '40001' back on the deterministic conflict raises in the same functions, reading
-- each live definition and substituting only the dedicated code literal (everything else byte-identical). WARNING: this
-- re-enables the PostgREST 14 infinite retry loop on those conflicts. The Dialpad classifiers accept both codes.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

do $migration$
declare
  r record;
  v_oid oid;
  v_def text;
  v_from text;
  v_to text;
  v_lit integer;
  v_raises integer;
begin
  for r in
    select * from (values
    ('fn_apply_and_record_ai_disposition_review_correction', 'JDC01', 9),
    ('fn_apply_and_record_jev_lead_decision_correction', 'JDC01', 6),
    ('fn_correct_ai_disposition_review', 'JDC01', 6),
    ('fn_correct_jev_lead_decision', 'JDC01', 7),
    ('fn_set_jev_outcome_threshold', 'JDC01', 2),
    ('fn_set_template_auto_send_approval', 'JDC01', 1),
    ('fn_undo_jev_action', 'JDC01', 5),
    ('begin_definitive_esign_template_provider_create_retry', 'ESG01', 1),
    ('claim_esign_template_provider_create', 'ESG01', 1),
    ('finalize_esign_template', 'ESG01', 2),
    ('mark_stale_esign_template_provider_create_unknown', 'ESG01', 1),
    ('publish_esign_template_edit_revision', 'ESG01', 4),
    ('record_definitive_esign_template_provider_create_failure', 'ESG01', 1),
    ('soft_delete_esign_template', 'ESG01', 1),
    ('fn_append_dialpad_recording_timing', 'DPR01', 3),
    ('fn_finalize_dialpad_recording_provider_window', 'DPR01', 1),
    ('fn_finalize_dialpad_recording_shadow', 'DPR01', 1),
    ('fn_finish_dialpad_recording_timing', 'DPR01', 1),
    ('fn_mark_dialpad_recording_eof', 'DPR01', 3),
    ('fn_mint_dialpad_recording_ingest_grant', 'DPR01', 1),
    ('fn_mint_dialpad_recording_next_epoch', 'DPR01', 1),
    ('fn_record_dialpad_recording_chunk', 'DPR01', 5),
    ('fn_record_dialpad_recording_pcm_progress', 'DPR01', 2),
    ('fn_record_dialpad_recording_vad_ranges', 'DPR01', 1),
    ('fn_register_dialpad_recording_result', 'DPR01', 1),
    ('fn_prepare_dialpad_call_intent', 'DPC01', 1),
    ('fn_assert_rep_sms_obligation_dispatch', 'RSM01', 1),
    ('fn_claim_rep_sms_delivery', 'RSM01', 2),
    ('fn_claim_rep_sms_delivery_with_composition', 'RSM01', 2),
    ('fn_owner_correct_rep_sms_obligation', 'RSM01', 2),
    ('fn_record_rep_sms_delivery_result', 'RSM01', 4),
    ('fn_record_rep_sms_obligation_result', 'RSM01', 2),
    ('rep_sms_obligation_transition_guard', 'RSM01', 1),
    ('fn_complete_call_facts', 'NRT01', 2),
    ('fn_save_offer_calculation', 'NRT01', 1),
    ('save_unverified_lead_phone', 'NRT01', 1)
    ) as t(name, code, expected)
  loop
    select count(*) into v_lit
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = r.name and p.prokind = 'f';
    if v_lit <> 1 then
      raise exception 'expected exactly one public.% overload, found %', r.name, v_lit;
    end if;

    select p.oid into v_oid
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = r.name and p.prokind = 'f';

    v_from := quote_literal(r.code);
    v_to := $q$'40001'$q$;
    v_def := pg_get_functiondef(v_oid);
    v_lit := (length(v_def) - length(replace(v_def, v_from, ''))) / length(v_from);
    select count(*) into v_raises from regexp_matches(v_def, 'errcode\s*=\s*' || v_from, 'g');
    -- Every occurrence of the code literal must be a raise errcode, and the count must be exactly as reviewed.
    if v_lit <> r.expected or v_raises <> r.expected then
      raise exception 'public.%: expected % dedicated-code raises, found % literals / % raises', r.name, r.expected, v_lit, v_raises;
    end if;

    execute replace(v_def, v_from, v_to);
  end loop;
end;
$migration$;

commit;
