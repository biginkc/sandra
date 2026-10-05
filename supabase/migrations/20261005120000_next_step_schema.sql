-- My Leads one-call close, P1a-core (1a.1): additive next-step schema.
--
-- Schema only. NO data step: this migration auto-applies to production about a minute after
-- the merge, so it changes no existing row's meaning (mode defaults to 'phone', the generated
-- next_step_kind is derived, the attribution CHECK is only widened, the flag table starts
-- empty and a missing row reads OFF). Relabeling real leads is a separate operator-run
-- function (20261005121500) behind a pasted preview.
--
-- next_step_kind is STORED (PG17 has no virtual generated columns), so adding it rewrites
-- public.tasks once under a brief ACCESS EXCLUSIVE lock; the builder checked the table size
-- before shipping (see the PR body).
begin;

alter table public.tasks
  add column mode text not null default 'phone',
  add column location text,
  add column next_step_kind text generated always as (
    case type
      when 'appointment' then 'appointment'
      when 'callback' then 'appointment'
      when 'follow_up' then 'appointment'
      else 'task'
    end) stored;

alter table public.tasks
  add constraint tasks_mode_check check (mode in ('phone', 'in_person')),
  add constraint tasks_in_person_appointment_check check (mode = 'phone' or type = 'appointment'),
  add constraint tasks_location_check
    check (location is null or (mode = 'in_person' and length(location) <= 500));

-- A relabeled follow-up keeps its lead-next-action idempotency key; the old CHECK
-- (20260815233000_leads_urgency_paging.sql) only allowed type = 'follow_up'.
alter table public.tasks drop constraint tasks_lead_next_action_follow_up_check;
alter table public.tasks add constraint tasks_lead_next_action_follow_up_check
  check (lead_next_action_idempotency_key is null or type in ('follow_up', 'appointment'));

-- The attribution source CHECK is an unnamed inline `check (source = 'booking_insert')`
-- (20260912111000_acquisition_kpis.sql); locate it by definition, not by name.
do $$
declare
  v_name text;
begin
  select c.conname into v_name
  from pg_constraint c
  where c.conrelid = 'public.acquisition_appointment_attribution'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%booking_insert%';
  if v_name is null then
    raise exception 'attribution source check not found';
  end if;
  execute format('alter table public.acquisition_appointment_attribution drop constraint %I', v_name);
end $$;

alter table public.acquisition_appointment_attribution
  add constraint acquisition_appointment_attribution_source_check
  check (source in ('booking_insert', 'relabel_2026_10', 'next_step_conversion', 'offer_backfill'));

-- Kill switches. Every new surface and every new job checks its own flag server-side; a
-- missing table, row or column reads as OFF (src/lib/my-leads/flags.ts). Rows are seeded by
-- scripts/my-leads-flags.mjs, never by this migration.
create table public.my_leads_feature_flags (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  call_next_strip boolean not null default false,
  post_call_prompt boolean not null default false,
  click_to_dial boolean not null default false,
  native_matcher boolean not null default false,
  auto_prompt boolean not null default false,
  callback_alert boolean not null default false,
  call_screen boolean not null default false,
  contract_card boolean not null default false,
  seller_reminders boolean not null default false,
  artifact_fetch boolean not null default false,
  facts_job boolean not null default false,
  offer_projection boolean not null default false,
  comp_queue boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.my_leads_feature_flags enable row level security;
revoke all on public.my_leads_feature_flags from public, anon, authenticated;
grant select, insert, update on public.my_leads_feature_flags to service_role;

-- Read-only catalog probe behind src/lib/my-leads/schema-ready.ts. PostgREST cannot call
-- to_regprocedure or read information_schema, so the helper asks this one service-only
-- function whether the exact functions ('public.fn(argtypes)') and columns ('table.column',
-- public schema) a feature's code path needs exist yet. Until THIS migration has applied the
-- RPC itself is missing, which the helper also treats as "not ready".
create or replace function public.fn_my_leads_schema_probe(p_functions text[], p_columns text[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_functions jsonb := '{}'::jsonb;
  v_columns jsonb := '{}'::jsonb;
  v_item text;
  v_table text;
  v_column text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if coalesce(array_length(p_functions, 1), 0) > 50 or coalesce(array_length(p_columns, 1), 0) > 50 then
    raise exception 'too many probe items' using errcode = '22023';
  end if;
  foreach v_item in array coalesce(p_functions, '{}'::text[]) loop
    begin
      v_functions := v_functions || jsonb_build_object(v_item, to_regprocedure(v_item) is not null);
    exception when others then
      v_functions := v_functions || jsonb_build_object(v_item, false);
    end;
  end loop;
  foreach v_item in array coalesce(p_columns, '{}'::text[]) loop
    v_table := split_part(v_item, '.', 1);
    v_column := split_part(v_item, '.', 2);
    v_columns := v_columns || jsonb_build_object(v_item, exists (
      select 1
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = v_table and a.attname = v_column
        and a.attnum > 0 and not a.attisdropped));
  end loop;
  return jsonb_build_object('functions', v_functions, 'columns', v_columns);
end $$;
revoke all on function public.fn_my_leads_schema_probe(text[], text[]) from public, anon, authenticated;
grant execute on function public.fn_my_leads_schema_probe(text[], text[]) to service_role;

commit;
