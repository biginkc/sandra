-- My Leads one-call close, P2 data plane (2.1): shared ledger-key helpers, native/direction columns on
-- call intents, and replacement of every literal 'dialpad-cti:' site by those helpers.
--
-- Schema and function patches only, NO data step. Inert by itself: every existing row is a Sandra
-- intent (origin 'sandra', direction 'outbound') and the helpers return exactly what the literals did,
-- so nothing changes until 2.4 writes native keys.
--
-- Semantic preservation: no function body is re-typed. Each live function is patched in place with
-- pg_get_functiondef + an anchored replace (the technique of 20260929220000_dialpad_recording_transport_contract),
-- asserting the anchor exists the expected number of times, so the live body (including P1c/P1d changes)
-- is preserved byte for byte outside the replaced hunks. Re-running the file is a no-op.
begin;

alter table public.dialpad_call_intents
  add column if not exists origin text not null default 'sandra',
  add column if not exists direction text not null default 'outbound';
do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'dialpad_call_intents_origin_check') then
    alter table public.dialpad_call_intents
      add constraint dialpad_call_intents_origin_check check (origin in ('sandra', 'native'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'dialpad_call_intents_direction_check') then
    alter table public.dialpad_call_intents
      add constraint dialpad_call_intents_direction_check check (direction in ('outbound', 'inbound'));
  end if;
end $c$;
comment on column public.dialpad_call_intents.origin is
  'sandra: prepared by Sandra before dialing. native: synthesized when a call dialed outside Sandra is matched to a lead.';

-- Pure helpers (used in an index predicate and a CHECK, so immutable). The ledger key of a call is
-- 'dialpad-cti:<intent id>' for a Sandra-origin intent and 'dialpad-native:<provider call id>' for a native one.
create or replace function public.dialpad_cti_is_ledger_key(p_key text) returns boolean
  language sql immutable parallel safe set search_path = ''
  as $$ select p_key like 'dialpad-cti:%' or p_key like 'dialpad-native:%' $$;
create or replace function public.dialpad_cti_intent_key(p_origin text, p_intent_id uuid, p_provider_call_id text) returns text
  language sql immutable set search_path = ''
  as $$ select case when p_origin = 'native' then 'dialpad-native:' || p_provider_call_id
                    else 'dialpad-cti:' || p_intent_id::text end $$;
revoke all on function public.dialpad_cti_is_ledger_key(text) from public, anon;
revoke all on function public.dialpad_cti_intent_key(text, uuid, text) from public, anon;
grant execute on function public.dialpad_cti_is_ledger_key(text) to authenticated, service_role;
grant execute on function public.dialpad_cti_intent_key(text, uuid, text) to authenticated, service_role;

-- Unique indexes: new first, then drop the old, so uniqueness is never unenforced.
create unique index if not exists idx_call_activities_org_dialpad_ledger_attempt
  on public.call_activities (org_id, jitter_attempt_id)
  where provider = 'dialpad' and public.dialpad_cti_is_ledger_key(jitter_attempt_id);
create unique index if not exists idx_call_activities_org_dialpad_ledger_call
  on public.call_activities (org_id, provider_call_id)
  where provider = 'dialpad' and public.dialpad_cti_is_ledger_key(jitter_attempt_id) and provider_call_id is not null;
drop index if exists public.idx_call_activities_org_dialpad_cti_attempt;
drop index if exists public.idx_call_activities_org_dialpad_cti_call;

-- Pending-outcome check: a superset of the old predicate. NOT VALID then VALIDATE (one scan).
alter table public.acquisition_attempts drop constraint if exists acquisition_attempts_pending_outcome_check;
alter table public.acquisition_attempts add constraint acquisition_attempts_pending_outcome_check check (
  source = 'sandra'
  or outcome is not null
  or (source = 'dialpad' and coalesce(public.dialpad_cti_is_ledger_key(provider_attempt_key), false))
) not valid;
alter table public.acquisition_attempts validate constraint acquisition_attempts_pending_outcome_check;

-- Anchored patches of the live function bodies.
do $patch$
declare
  r record;
  v_def text;
  v_new text;
  v_found int;
begin
  for r in select * from (values
    ('public.fn_get_acquisition_call_references(uuid,uuid,uuid)',
      'provider_attempt_key like ''dialpad-cti:%''',
      'public.dialpad_cti_is_ledger_key(provider_attempt_key)', 1),
    ('public.fn_finalize_acquisition_attempt_without_sms_obligation(jsonb)',
      'provider_attempt_key like ''dialpad-cti:%''',
      'public.dialpad_cti_is_ledger_key(provider_attempt_key)', 1),
    ('public.fn_open_dialpad_recording_capture(uuid,uuid,uuid)',
      '''dialpad-cti:'' || v_intent.id::text',
      'public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)', 1),
    ('public.fn_get_dialpad_call_status(uuid,uuid,uuid)',
      '''dialpad-cti:'' || v_intent.id::text',
      'public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)', 2),
    ('public.dialpad_cti_project_intent(uuid)',
      '''dialpad-cti:'' || v_intent.id::text',
      'public.dialpad_cti_intent_key(v_intent.origin, v_intent.id, v_intent.matched_provider_call_id)', 1),
    ('public.dialpad_cti_project_intent(uuid)',
      'jitter_attempt_id like ''dialpad-cti:%''',
      'public.dialpad_cti_is_ledger_key(jitter_attempt_id)', 1),
    ('public.fn_dialpad_recording_library_sources(uuid,text)',
      '''dialpad-cti:''||i.id::text',
      'public.dialpad_cti_intent_key(i.origin,i.id,i.matched_provider_call_id)', 1),
    ('public.fn_dialpad_recording_playback_file(uuid,text,text)',
      '''dialpad-cti:''||i.id::text',
      'public.dialpad_cti_intent_key(i.origin,i.id,i.matched_provider_call_id)', 1),
    ('public.my_leads_link_backfill_candidates(uuid)',
      '''dialpad-cti:'' || i.id::text',
      'public.dialpad_cti_intent_key(i.origin, i.id, i.matched_provider_call_id)', 2)
  ) as t(sig, anchor, repl, expected)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    v_found := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if v_found = 0 and position(r.repl in v_def) > 0 then
      continue; -- already patched
    end if;
    if v_found <> r.expected then
      raise exception 'ledger key patch: % expected % anchor(s) in %, found %', r.anchor, r.expected, r.sig, v_found;
    end if;
    v_new := replace(v_def, r.anchor, r.repl);
    execute v_new;
  end loop;
end $patch$;

commit;
