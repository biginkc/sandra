-- Rollback for 20261007170000_acquisition_offer_projections.
-- Drops the triggers, functions and projection table. The widened outcome constraint is restored
-- only when no 'superseded' offers exist: supersession is never recorded as a decline, so those rows
-- are NOT rewritten; if any exist the (additive, harmless) widened constraint is left in place.
begin;

do $unpatch2$
declare
  v_def text := pg_get_functiondef('public.fn_log_acquisition_offer(uuid,uuid,uuid,bigint,text,uuid,bigint,text,timestamptz,timestamptz,text,text,text)'::regprocedure);
begin
  if position($a1$    if p_motivation_kind is not null then
      perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
      v_kind := p_motivation_kind;
      v_text := case when p_motivation_kind = 'specified' then btrim(p_motivation_text) end;
    end if;
$a1$ in v_def) = 0 then raise exception 'fn_log_acquisition_offer anchor 1 not found'; end if;
  v_def := replace(v_def, $a1$    if p_motivation_kind is not null then
      perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
      v_kind := p_motivation_kind;
      v_text := case when p_motivation_kind = 'specified' then btrim(p_motivation_text) end;
    end if;
$a1$, $b1$    if p_motivation_kind is null then raise exception 'INVALID_INPUT' using errcode = '22023'; end if;
    perform public.my_leads_workflow_assert_motivation(p_motivation_kind, p_motivation_text);
    v_kind := p_motivation_kind;
    v_text := case when p_motivation_kind = 'specified' then btrim(p_motivation_text) end;
$b1$);
  if position($a2$        motivation_recorded = (v_kind is not null), motivation_kind = v_kind, motivation_text = v_text,
        motivation_recorded_at = case when v_kind is not null then coalesce(q.motivation_recorded_at, statement_timestamp()) end,
        motivation_recorded_by = case when v_kind is not null then coalesce(q.motivation_recorded_by, v_actor) end,
$a2$ in v_def) = 0 then raise exception 'fn_log_acquisition_offer anchor 2 not found'; end if;
  v_def := replace(v_def, $a2$        motivation_recorded = (v_kind is not null), motivation_kind = v_kind, motivation_text = v_text,
        motivation_recorded_at = case when v_kind is not null then coalesce(q.motivation_recorded_at, statement_timestamp()) end,
        motivation_recorded_by = case when v_kind is not null then coalesce(q.motivation_recorded_by, v_actor) end,
$a2$, $b2$        motivation_recorded = true, motivation_kind = v_kind, motivation_text = v_text,
        motivation_recorded_at = coalesce(q.motivation_recorded_at, statement_timestamp()),
        motivation_recorded_by = coalesce(q.motivation_recorded_by, v_actor),
$b2$);
  if position($a3$      p_org_id, p_property_id, 'offer_sent', p_sent_at, (v_kind is not null), v_kind, v_text,
      case when v_kind is not null then statement_timestamp() end, case when v_kind is not null then v_actor end, 1
$a3$ in v_def) = 0 then raise exception 'fn_log_acquisition_offer anchor 3 not found'; end if;
  v_def := replace(v_def, $a3$      p_org_id, p_property_id, 'offer_sent', p_sent_at, (v_kind is not null), v_kind, v_text,
      case when v_kind is not null then statement_timestamp() end, case when v_kind is not null then v_actor end, 1
$a3$, $b3$      p_org_id, p_property_id, 'offer_sent', p_sent_at, true, v_kind, v_text,
      statement_timestamp(), v_actor, 1
$b3$);
  execute v_def;
end
$unpatch2$;

do $unpatch$
declare
  v_def text := pg_get_functiondef('public.fn_get_acquisition_kpis(uuid,uuid,timestamptz,timestamptz)'::regprocedure);
begin
  execute replace(v_def, ' and outcome<>''superseded'';', ';');
end
$unpatch$;

drop trigger if exists trg_offer_projection_state on public.esign_requests;
drop trigger if exists trg_offer_projection_link on public.esign_requests;
drop function if exists public.fn_list_offer_conflicts(uuid, uuid, uuid);
drop function if exists public.fn_supersede_offer_and_log(uuid, uuid, uuid);
drop function if exists public.fn_offer_projection_due(integer);
drop function if exists public.fn_abandon_offer_projection(uuid);
drop function if exists public.fn_offer_projection_repair();
drop function if exists public.fn_retry_offer_projection(uuid, uuid, text);
drop function if exists public.fn_project_acquisition_offer(uuid);
drop function if exists public.fn_offer_projection_run(uuid, uuid, boolean, text);
drop function if exists public.fn_create_offer_projection(uuid, uuid, uuid, uuid, text, text, jsonb, bigint, date, text, text, text);
drop function if exists public.trg_offer_projection_state();
drop function if exists public.trg_offer_projection_link();
drop function if exists public.contract_follow_up_at(date, timestamptz, integer, smallint);
drop table if exists public.acquisition_offer_projections cascade;

do $$
begin
  if not exists (select 1 from public.acquisition_offers where outcome = 'superseded') then
    alter table public.acquisition_offers drop constraint acquisition_offers_outcome_check;
    alter table public.acquisition_offers add constraint acquisition_offers_outcome_check check (
      (outcome = 'pending' and outcome_at is null and outcome_by is null)
      or (outcome in ('accepted', 'declined') and outcome_at is not null and outcome_by is not null)
    );
  end if;
end $$;

commit;
