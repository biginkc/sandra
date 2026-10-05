-- My Leads one-call close, P2 data plane (2.3): contact_phone_numbers, the normalized phone lookup table
-- the native matcher (2.4) reads, and the trigger that keeps it in step with contacts.phone_1..3.
--
-- NO data step: the migration creates an empty table. Existing contacts are filled by the service-only
-- housekeeping function fn_contact_phone_numbers_backfill (run kind 'phone_backfill', preview then
-- --confirm, before-image first), which must be applied before the Dialpad connection is activated.
-- Inert until 2.4's resolver reads the table (and that is itself behind the native_matcher flag).
--
-- The housekeeping rollback entry point and its fingerprint are patched in place (anchored, asserted,
-- idempotent) to add the phone_backfill branch; every other line of the live bodies is untouched.
begin;

create table public.contact_phone_numbers (
  contact_id uuid not null references public.contacts(id) on delete cascade,
  slot smallint not null check (slot between 1 and 3),
  org_id uuid not null references public.organizations(id) on delete cascade,
  e164 text not null check (e164 ~ '^\+1[0-9]{10}$'),
  digits10 text not null generated always as (right(e164, 10)) stored,
  updated_at timestamptz not null default now(),
  primary key (contact_id, slot)
);
create index contact_phone_numbers_org_digits_idx on public.contact_phone_numbers (org_id, digits10);
alter table public.contact_phone_numbers enable row level security;
revoke all on table public.contact_phone_numbers from public, anon, authenticated, service_role;
grant select on public.contact_phone_numbers to service_role;
comment on table public.contact_phone_numbers is
  'Normalized US phones of contacts (slots 1-3), maintained by trigger from contacts.phone_1..3. Same normalizer as dial authorization.';

create or replace function public.contact_phone_numbers_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v text;
  i integer;
begin
  for i in 1..3 loop
    v := public.dialpad_cti_normalize_us_phone(case i when 1 then new.phone_1 when 2 then new.phone_2 else new.phone_3 end);
    if v is null then
      delete from public.contact_phone_numbers where contact_id = new.id and slot = i;
    else
      insert into public.contact_phone_numbers as n (contact_id, slot, org_id, e164)
      values (new.id, i, new.org_id, v)
      on conflict (contact_id, slot) do update
        set e164 = excluded.e164, org_id = excluded.org_id, updated_at = now()
        where n.e164 is distinct from excluded.e164 or n.org_id is distinct from excluded.org_id;
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.contact_phone_numbers_sync() from public, anon, authenticated, service_role;

create trigger contact_phone_numbers_sync_insert
  after insert on public.contacts
  for each row execute function public.contact_phone_numbers_sync();
create trigger contact_phone_numbers_sync_update
  after update of phone_1, phone_2, phone_3 on public.contacts
  for each row
  when (old.phone_1 is distinct from new.phone_1 or old.phone_2 is distinct from new.phone_2 or old.phone_3 is distinct from new.phone_3)
  execute function public.contact_phone_numbers_sync();

-- Backfill candidates: slots whose normalized phone has no row yet, or a different row.
create or replace function public.my_leads_phone_backfill_candidates(p_org_id uuid)
returns table (contact_id uuid, slot smallint, e164 text, existing_e164 text, existing_updated_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select c.id, s.slot::smallint, public.dialpad_cti_normalize_us_phone(s.phone), n.e164, n.updated_at
  from public.contacts c
  cross join lateral (values (1, c.phone_1), (2, c.phone_2), (3, c.phone_3)) as s(slot, phone)
  left join public.contact_phone_numbers n on n.contact_id = c.id and n.slot = s.slot::smallint and n.org_id = p_org_id
  where c.org_id = p_org_id
    and public.dialpad_cti_normalize_us_phone(s.phone) is not null
    and n.e164 is distinct from public.dialpad_cti_normalize_us_phone(s.phone)
$$;
revoke all on function public.my_leads_phone_backfill_candidates(uuid) from public, anon, authenticated, service_role;

-- Shared apply contract (P1e): preview writes nothing and prints counts and ids only (never a number);
-- apply needs the preview fingerprint, takes the org lock, locks the candidate contacts in id order,
-- recomputes the fingerprint under those locks and raises FINGERPRINT_MISMATCH (writing nothing) on any
-- difference. Each row is imaged first: op 'created' (no row existed) or 'updated' (before = old row).
create or replace function public.fn_contact_phone_numbers_backfill(
  p_org_id uuid,
  p_apply boolean default false,
  p_fingerprint text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
  v_created int;
  v_updated int;
  v_fp text;
  v_sample jsonb;
  v_preview jsonb;
  v_run uuid;
  v_now timestamptz;
begin
  perform public.my_leads_housekeeping_require_service();
  if p_org_id is null then
    raise exception 'INVALID_INPUT: org is required' using errcode = 'P0001';
  end if;

  if p_apply then
    if p_fingerprint is null then
      raise exception 'FINGERPRINT_REQUIRED: apply needs the fingerprint from the preview' using errcode = 'P0001';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('my-leads-housekeeping:' || p_org_id::text, 0));
    perform 1 from public.contacts c
    where c.org_id = p_org_id and c.id in (select k.contact_id from public.my_leads_phone_backfill_candidates(p_org_id) k)
    order by c.id for update;
  end if;

  select count(*)::int,
         (count(*) filter (where k.existing_e164 is null))::int,
         (count(*) filter (where k.existing_e164 is not null))::int,
         encode(sha256(convert_to('phone_backfill|' || coalesce(string_agg(
           k.contact_id::text || ':' || k.slot::text || ':' || k.e164 || ':' || coalesce(k.existing_e164, ''),
           ',' order by k.contact_id, k.slot), ''), 'utf8')), 'hex')
  into v_count, v_created, v_updated, v_fp
  from public.my_leads_phone_backfill_candidates(p_org_id) k;
  select coalesce(jsonb_agg(u.x order by u.x), '[]'::jsonb) into v_sample from (
    select distinct k.contact_id::text as x from public.my_leads_phone_backfill_candidates(p_org_id) k order by 1 limit 20) u;

  v_preview := jsonb_build_object(
    'kind', 'phone_backfill', 'candidates', v_count, 'toCreate', v_created, 'toUpdate', v_updated,
    'sample', v_sample, 'fingerprint', v_fp);
  if not p_apply then
    return v_preview;
  end if;
  if p_fingerprint is distinct from v_fp then
    raise exception 'FINGERPRINT_MISMATCH: the cohort changed since the preview; run a new preview' using errcode = 'P0001';
  end if;
  if v_count = 0 then
    return v_preview || jsonb_build_object('noop', true, 'runId', null);
  end if;

  v_now := clock_timestamp();
  insert into public.my_leads_housekeeping_runs (org_id, kind, params, created_at)
  values (p_org_id, 'phone_backfill', jsonb_build_object('fingerprint', v_fp), clock_timestamp())
  returning id into v_run;

  insert into public.my_leads_housekeeping_before_images (run_id, table_name, row_id, before)
  select v_run, 'contact_phone_numbers', md5(k.contact_id::text || ':' || k.slot::text)::uuid,
         case when k.existing_e164 is null
           then jsonb_build_object('op', 'created', 'contact_id', k.contact_id, 'slot', k.slot,
                                   'applied_e164', k.e164, 'applied_updated_at', v_now)
           else jsonb_build_object('op', 'updated', 'contact_id', k.contact_id, 'slot', k.slot,
                                   'e164', k.existing_e164, 'updated_at', k.existing_updated_at,
                                   'applied_e164', k.e164, 'applied_updated_at', v_now)
         end
  from public.my_leads_phone_backfill_candidates(p_org_id) k;

  insert into public.contact_phone_numbers as n (contact_id, slot, org_id, e164, updated_at)
  select k.contact_id, k.slot, p_org_id, k.e164, v_now
  from public.my_leads_phone_backfill_candidates(p_org_id) k
  on conflict (contact_id, slot) do update set e164 = excluded.e164, updated_at = excluded.updated_at;

  update public.my_leads_housekeeping_runs
  set summary = jsonb_build_object('created', v_created, 'updated', v_updated)
  where id = v_run and org_id = p_org_id;
  return v_preview || jsonb_build_object('runId', v_run, 'created', v_created, 'updated', v_updated);
end $$;
revoke all on function public.fn_contact_phone_numbers_backfill(uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.fn_contact_phone_numbers_backfill(uuid, boolean, text) to service_role;

-- Rollback support: anchored patches of the live fingerprint and rollback functions.
do $patch$
declare
  r record;
  v_def text;
  v_found int;
begin
  for r in select * from (values
    ('public.my_leads_housekeeping_rollback_fingerprint(uuid,uuid)',
      E'          when ''acquisition_assignment_episodes'' then',
      E'          when ''contact_phone_numbers'' then (select n.e164 || ''/'' || n.updated_at::text\n'
      '            from public.contact_phone_numbers n where n.contact_id = (b.before ->> ''contact_id'')::uuid\n'
      '              and n.slot = (b.before ->> ''slot'')::smallint and n.org_id = p_org_id)\n'
      '          when ''acquisition_assignment_episodes'' then'),
    ('public.fn_my_leads_housekeeping_rollback(uuid,uuid,text)',
      E'  perform 1 from public.acquisition_appointment_attribution aa\n',
      E'  perform 1 from public.contact_phone_numbers cpn\n'
      '  where cpn.org_id = p_org_id and (cpn.contact_id, cpn.slot) in (\n'
      '    select (b.before ->> ''contact_id'')::uuid, (b.before ->> ''slot'')::smallint\n'
      '    from public.my_leads_housekeeping_before_images b\n'
      '    where b.run_id = p_run and b.table_name = ''contact_phone_numbers'') order by cpn.contact_id, cpn.slot for update;\n'
      '  perform 1 from public.acquisition_appointment_attribution aa\n'),
    ('public.fn_my_leads_housekeeping_rollback(uuid,uuid,text)',
      E'  else\n    raise exception ''ROLLBACK_UNSUPPORTED',
      E'  elsif v_run.kind = ''phone_backfill'' then\n'
      '    -- A row goes back only while it still equals what the run wrote (the maintaining trigger or a\n'
      '    -- later edit may have rewritten it since). A created row is removed only when no native call\n'
      '    -- intent references its contact; anything else is reported, never forced.\n'
      '    for r in\n'
      '      select b.row_id, b.before from public.my_leads_housekeeping_before_images b\n'
      '      where b.run_id = p_run and b.table_name = ''contact_phone_numbers'' order by b.row_id\n'
      '    loop\n'
      '      begin\n'
      '        select n.e164, n.updated_at into v_cur from public.contact_phone_numbers n\n'
      '        where n.contact_id = (r.before ->> ''contact_id'')::uuid and n.slot = (r.before ->> ''slot'')::smallint\n'
      '          and n.org_id = p_org_id;\n'
      '        if not found then\n'
      '          if r.before ->> ''op'' = ''created'' then\n'
      '            v_already := v_already + 1;\n'
      '            continue;\n'
      '          end if;\n'
      '          raise exception ''ROW_MISSING'' using errcode = ''P0001'';\n'
      '        end if;\n'
      '        if r.before ->> ''op'' = ''updated'' and v_cur.e164 is not distinct from (r.before ->> ''e164'')\n'
      '           and v_cur.updated_at is not distinct from (r.before ->> ''updated_at'')::timestamptz then\n'
      '          v_already := v_already + 1;\n'
      '          continue;\n'
      '        end if;\n'
      '        if v_cur.e164 is distinct from (r.before ->> ''applied_e164'')\n'
      '           or v_cur.updated_at is distinct from (r.before ->> ''applied_updated_at'')::timestamptz then\n'
      '          raise exception ''CHANGED_SINCE'' using errcode = ''P0001'';\n'
      '        end if;\n'
      '        if r.before ->> ''op'' = ''created'' then\n'
      '          if exists (select 1 from public.dialpad_call_intents i\n'
      '                     where i.org_id = p_org_id and i.origin = ''native''\n'
      '                       and i.contact_id = (r.before ->> ''contact_id'')::uuid) then\n'
      '            raise exception ''NATIVE_CALL_REFERENCES'' using errcode = ''P0001'';\n'
      '          end if;\n'
      '          delete from public.contact_phone_numbers n\n'
      '          where n.contact_id = (r.before ->> ''contact_id'')::uuid and n.slot = (r.before ->> ''slot'')::smallint\n'
      '            and n.org_id = p_org_id and n.e164 = (r.before ->> ''applied_e164'')\n'
      '            and n.updated_at = (r.before ->> ''applied_updated_at'')::timestamptz;\n'
      '        else\n'
      '          update public.contact_phone_numbers n\n'
      '          set e164 = r.before ->> ''e164'', updated_at = (r.before ->> ''updated_at'')::timestamptz\n'
      '          where n.contact_id = (r.before ->> ''contact_id'')::uuid and n.slot = (r.before ->> ''slot'')::smallint\n'
      '            and n.org_id = p_org_id and n.e164 = (r.before ->> ''applied_e164'')\n'
      '            and n.updated_at = (r.before ->> ''applied_updated_at'')::timestamptz;\n'
      '        end if;\n'
      '        get diagnostics v_rows = row_count;\n'
      '        if v_rows <> 1 then\n'
      '          raise exception ''ROW_CHANGED'' using errcode = ''P0001'';\n'
      '        end if;\n'
      '        v_restored := v_restored + 1;\n'
      '      exception when others then\n'
      '        v_not_restored := v_not_restored || jsonb_build_array(jsonb_build_object(\n'
      '          ''contact'', r.before ->> ''contact_id'', ''slot'', r.before ->> ''slot'', ''reason'', sqlerrm, ''code'', sqlstate));\n'
      '      end;\n'
      '    end loop;\n\n'
      '  else\n    raise exception ''ROLLBACK_UNSUPPORTED')
  ) as t(sig, anchor, repl)
  loop
    v_def := pg_get_functiondef(r.sig::regprocedure);
    v_found := (length(v_def) - length(replace(v_def, r.anchor, ''))) / length(r.anchor);
    if position(r.repl in v_def) > 0 then continue; end if; -- already patched
    if v_found <> 1 then
      raise exception 'phone backfill rollback patch: expected one anchor in %, found %', r.sig, v_found;
    end if;
    execute replace(v_def, r.anchor, r.repl);
  end loop;
end $patch$;

commit;
