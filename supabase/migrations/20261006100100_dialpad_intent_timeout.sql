-- My Leads one-call close, P2 data plane (2.2): an authorized dial with no provider event for 2 minutes
-- is MARKED failed (intent.failed_at). It is a marker, not a terminal status: a late event inside the
-- intent's own window still matches and projects, because the call really happened. A failed intent
-- never created an attempt or activity (those come only from the projection), so it counts as no touch.
--
-- Inert until the sweep calls fn_fail_stale_dialpad_intents. The guard and status function are patched
-- in place (anchored, asserted, idempotent) so every other line of the live bodies is untouched.
begin;

alter table public.dialpad_call_intents add column if not exists failed_at timestamptz;
comment on column public.dialpad_call_intents.failed_at is
  'Set once by fn_fail_stale_dialpad_intents when an authorized dial got no provider event in time. A marker only: a late event still matches.';

do $patch$
declare
  r record;
  v_def text;
  v_found int;
begin
  for r in select * from (values
    ('public.dialpad_cti_guard_intent()',
      'array[''status'', ''matched_provider_call_id'', ''matched_event_id'', ''matched_at'', ''cancelled_at'', ''dispatch_authorized_at'']',
      'array[''status'', ''matched_provider_call_id'', ''matched_event_id'', ''matched_at'', ''cancelled_at'', ''dispatch_authorized_at'', ''failed_at'']'),
    ('public.dialpad_cti_guard_intent()',
      'or new.matched_at is not null or new.cancelled_at is not null or new.dispatch_authorized_at is not null then',
      'or new.matched_at is not null or new.cancelled_at is not null or new.dispatch_authorized_at is not null or new.failed_at is not null then'),
    ('public.dialpad_cti_guard_intent()',
      E'raise exception ''dispatch authorization is set once, while the intent is prepared'' using errcode = ''42501'';\n  end if;\n  return new;',
      E'raise exception ''dispatch authorization is set once, while the intent is prepared'' using errcode = ''42501'';\n  end if;\n'
      '  if new.failed_at is distinct from old.failed_at\n'
      '     and (old.failed_at is not null or new.failed_at is null or old.dispatch_authorized_at is null or old.status <> ''prepared'') then\n'
      '    raise exception ''failed marker is set once, on a dispatched prepared intent'' using errcode = ''42501'';\n  end if;\n  return new;'),
    ('public.fn_get_dialpad_call_status(uuid,uuid,uuid)',
      'when v_intent.expires_at <= now() then ''expired''',
      'when v_intent.failed_at is not null then ''failed'' when v_intent.expires_at <= now() then ''expired'''),
    ('public.fn_get_dialpad_call_status(uuid,uuid,uuid)',
      '''expiresAt'', v_intent.expires_at,',
      '''expiresAt'', v_intent.expires_at, ''failedAt'', v_intent.failed_at,')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    v_found := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if position(r.repl in v_def) > 0 then continue; end if; -- already patched
    if v_found <> 1 then
      raise exception 'intent timeout patch: expected one anchor in %, found %: %', r.sig, v_found, left(r.anchor, 60);
    end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $patch$;

create or replace function public.fn_fail_stale_dialpad_intents(p_cutoff_seconds integer default 120, p_limit integer default 200)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_n integer;
begin
  if p_cutoff_seconds not between 30 and 900 or p_limit not between 1 and 1000 then
    raise exception 'INVALID_INPUT' using errcode = '22023';
  end if;
  with due as (
    select id from public.dialpad_call_intents
    where status = 'prepared' and failed_at is null and dispatch_authorized_at is not null
      and dispatch_authorized_at <= now() - make_interval(secs => p_cutoff_seconds)
    order by dispatch_authorized_at limit p_limit for update skip locked)
  update public.dialpad_call_intents i set failed_at = now() from due where i.id = due.id;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.fn_fail_stale_dialpad_intents(integer, integer) from public, anon, authenticated;
grant execute on function public.fn_fail_stale_dialpad_intents(integer, integer) to service_role;

commit;
