-- Rollback for 20261006100600_call_prompt_acknowledgement. Turn auto_prompt off first.
-- Drops the three functions and the index; the two nullable columns stay (acknowledgements already
-- recorded are audit data). An applied ack_legacy_prompts run is undone separately with
-- fn_my_leads_housekeeping_rollback(run_id) before this file runs (its branch is removed here).
begin;
drop function if exists public.fn_my_leads_ack_legacy_call_prompts(uuid, boolean, text);
drop function if exists public.fn_acknowledge_call_prompt(uuid, uuid, text);
drop function if exists public.fn_list_unacknowledged_call_prompts(uuid, integer, timestamptz, uuid, interval);
drop index if exists public.acquisition_attempts_unacked_prompt_idx;
do $patch$
declare
  v_def text;
  v_start int;
  v_end int;
begin
  -- Fingerprint: remove the ack_legacy_prompts suffix line.
  v_def := pg_get_functiondef('public.my_leads_housekeeping_rollback_fingerprint(uuid,uuid)'::regprocedure);
  if position('r.kind = ''ack_legacy_prompts''' in v_def) > 0 then
    execute replace(v_def,
      E'            || case when r.kind = ''ack_legacy_prompts'' then ''/'' || coalesce(a.prompt_acknowledged_at::text, '''') || ''/'' || coalesce(a.prompt_acknowledged_via, '''') else '''' end\n',
      '');
  end if;
  -- Rollback entry point: cut the whole ack_legacy_prompts branch up to the trailing `else`.
  v_def := pg_get_functiondef('public.fn_my_leads_housekeeping_rollback(uuid,uuid,text)'::regprocedure);
  v_start := position(E'  elsif v_run.kind = ''ack_legacy_prompts'' then\n' in v_def);
  if v_start > 0 then
    v_end := position(E'  else\n    raise exception ''ROLLBACK_UNSUPPORTED' in v_def);
    if v_end > v_start then
      execute left(v_def, v_start - 1) || substr(v_def, v_end);
    end if;
  end if;
end $patch$;
commit;
