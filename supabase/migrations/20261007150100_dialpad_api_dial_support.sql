-- My Leads one-call close, P2 UI (2.7): API dial support.
--
-- 1. Dial eligibility (cross-phase contract "Dial eligibility", flagged for orchestrator review): the
--    two dial authorization functions no longer require acquisition_assignment_episodes.eligible.
--    Reassigned leads carry eligible=false (their first-call clock must not restart), which locked
--    them out of dialing. An OPEN episode whose assignee is the rep, and properties.assigned_user_id
--    = rep, are still required. Both patches are anchored text replacements of the live definitions
--    (pg_get_functiondef, exactly one anchor asserted, idempotent); no body is re-typed.
-- 2. fn_authorize_dialpad_dispatch releases the frozen dialpadUserId beside the dial payload so the
--    server-side dialer (api-dial.ts) never trusts a browser-claimed id.
-- 3. dialpad_org_connections.dial_endpoint ('initiate_call' | 'call', Phase 0 decides; default
--    initiate_call) and dial_api_key_ref (null = reuse directory_api_key_ref). Both service-only: the
--    authenticated column grant is column-listed and is not widened.
-- 4. fn_dialpad_call_slots: read-only DNC/validity pre-check per phone slot for the strip and the
--    callback banner. Enforcement is unchanged and not duplicated (prepare + authorize re-prove it).
--
-- NO data step. Inert until click_to_dial is on and schemaReady('api_dial') is true.
begin;

alter table public.dialpad_org_connections
  add column if not exists dial_endpoint text not null default 'initiate_call'
    check (dial_endpoint in ('initiate_call', 'call')),
  add column if not exists dial_api_key_ref text
    check (dial_api_key_ref is null or dial_api_key_ref ~ '^env:DIALPAD_CTI_DIAL_KEY_[A-Z0-9_]{1,120}$');

do $patch$
declare
  r record;
  v_def text;
  v_found int;
begin
  for r in select * from (values
    ('public.fn_prepare_dialpad_call_intent(uuid,uuid,uuid,uuid,smallint,uuid,uuid,integer)',
      E'  if not found or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible\n',
      E'  if not found or v_episode.assignee_user_id <> p_rep_user_id\n'),
    ('public.fn_authorize_dialpad_dispatch(uuid,uuid,uuid)',
      E'  elsif v_episode.id is null or v_episode.assignee_user_id <> p_rep_user_id or not v_episode.eligible\n',
      E'  elsif v_episode.id is null or v_episode.assignee_user_id <> p_rep_user_id\n'),
    ('public.fn_authorize_dialpad_dispatch(uuid,uuid,uuid)',
      E'      ''phoneNumber'', v_intent.destination_e164,\n',
      E'      ''dialpadUserId'', v_intent.dialpad_user_id,\n      ''phoneNumber'', v_intent.destination_e164,\n')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    v_found := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if position(r.repl in v_def) > 0 then continue; end if; -- already patched
    if v_found <> 1 then
      raise exception 'api dial patch: expected one anchor in %, found %: %', r.sig, v_found, left(r.anchor, 70);
    end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
  -- Post-condition: neither dial function reads the eligibility flag any more.
  if position('v_episode.eligible' in pg_get_functiondef('public.fn_prepare_dialpad_call_intent(uuid,uuid,uuid,uuid,smallint,uuid,uuid,integer)'::regprocedure)) > 0
     or position('v_episode.eligible' in pg_get_functiondef('public.fn_authorize_dialpad_dispatch(uuid,uuid,uuid)'::regprocedure)) > 0 then
    raise exception 'api dial patch: an eligibility check survived';
  end if;
end $patch$;

-- Per-slot pre-check. Service role only (the server action calls it); never a substitute for the
-- checks inside fn_prepare_dialpad_call_intent / fn_authorize_dialpad_dispatch.
create or replace function public.fn_dialpad_call_slots(
  p_org_id uuid, p_rep_user_id uuid, p_property_id uuid, p_contact_id uuid
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_property public.properties%rowtype;
  v_contact public.contacts%rowtype;
  v_slot int;
  v_raw text;
  v_phone text;
  v_reason text;
  v_out jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
  if p_org_id is null or p_rep_user_id is null or p_property_id is null or p_contact_id is null then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  select * into v_property from public.properties where id = p_property_id and org_id = p_org_id;
  if not found or v_property.deleted_at is not null then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  select * into v_contact from public.contacts where id = p_contact_id and org_id = p_org_id;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'P0002';
  end if;
  for v_slot in 1..3 loop
    v_raw := case v_slot when 1 then v_contact.phone_1 when 2 then v_contact.phone_2 else v_contact.phone_3 end;
    v_phone := public.dialpad_cti_normalize_us_phone(v_raw);
    v_reason := case
      when coalesce(v_property.is_dnc_locked, false) then 'property_dnc'
      when v_contact.do_not_contact then 'contact_dnc'
      when v_phone is null then 'invalid'
      when exists (select 1 from public.global_phone_dnc_registry g where g.org_id = p_org_id and g.phone_e164 = v_phone) then 'phone_dnc'
      else null
    end;
    v_out := v_out || jsonb_build_object('slot', v_slot, 'callable', v_reason is null, 'reason', v_reason);
  end loop;
  return v_out;
end;
$$;
revoke all on function public.fn_dialpad_call_slots(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.fn_dialpad_call_slots(uuid, uuid, uuid, uuid) to service_role;

commit;
