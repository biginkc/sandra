-- Close webhook_events org scope and tighten remaining low-risk grants.

begin;

-- webhook_events was created before org-scoped RLS and had
-- authenticated ALL using/check true. Add a real tenant discriminator,
-- backfill the current single-org rows, and scope both RLS and
-- idempotency to the caller's memberships.
alter table public.webhook_events
  add column if not exists org_id uuid;

update public.webhook_events
set org_id = '00000000-0000-0000-0000-000000000bbb'
where org_id is null;

alter table public.webhook_events
  alter column org_id set default '00000000-0000-0000-0000-000000000bbb',
  alter column org_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'webhook_events_org_id_fkey'
      and conrelid = 'public.webhook_events'::regclass
  ) then
    alter table public.webhook_events
      add constraint webhook_events_org_id_fkey
      foreign key (org_id)
      references public.organizations(id)
      on delete cascade
      not valid;
  end if;
end;
$$;

alter table public.webhook_events
  validate constraint webhook_events_org_id_fkey;

create index if not exists idx_webhook_events_org_received
  on public.webhook_events (org_id, received_at desc);

drop index if exists public.webhook_events_idempotency_key;
create unique index if not exists webhook_events_org_idempotency_key
  on public.webhook_events (org_id, provider, event_type, external_id);

drop policy if exists webhook_events_authenticated_all on public.webhook_events;
drop policy if exists webhook_events_org_select on public.webhook_events;
drop policy if exists webhook_events_org_insert on public.webhook_events;
drop policy if exists webhook_events_org_update on public.webhook_events;
drop policy if exists webhook_events_org_delete on public.webhook_events;

create policy webhook_events_org_select on public.webhook_events
  for select
  to authenticated
  using (
    org_id in (
      select m.org_id from public.memberships m where m.user_id = auth.uid()
    )
  );

create policy webhook_events_org_insert on public.webhook_events
  for insert
  to authenticated
  with check (
    org_id in (
      select m.org_id from public.memberships m where m.user_id = auth.uid()
    )
  );

create policy webhook_events_org_update on public.webhook_events
  for update
  to authenticated
  using (
    org_id in (
      select m.org_id from public.memberships m where m.user_id = auth.uid()
    )
  )
  with check (
    org_id in (
      select m.org_id from public.memberships m where m.user_id = auth.uid()
    )
  );

create policy webhook_events_org_delete on public.webhook_events
  for delete
  to authenticated
  using (
    org_id in (
      select m.org_id from public.memberships m where m.user_id = auth.uid()
    )
  );

-- Reference data remains readable to signed-in users but writable only by
-- service_role/data-seed paths.
drop policy if exists fips_codes_authenticated_all on public.fips_codes;
drop policy if exists zip_county_xref_authenticated_all on public.zip_county_xref;
drop policy if exists fips_codes_authenticated_select on public.fips_codes;
drop policy if exists zip_county_xref_authenticated_select on public.zip_county_xref;
drop policy if exists fips_codes_service_write on public.fips_codes;
drop policy if exists zip_county_xref_service_write on public.zip_county_xref;

create policy fips_codes_authenticated_select on public.fips_codes
  for select
  to authenticated
  using (true);

create policy zip_county_xref_authenticated_select on public.zip_county_xref
  for select
  to authenticated
  using (true);

create policy fips_codes_service_write on public.fips_codes
  for all
  to service_role
  using (true)
  with check (true);

create policy zip_county_xref_service_write on public.zip_county_xref
  for all
  to service_role
  using (true)
  with check (true);

revoke insert, update, delete on table public.fips_codes from anon, authenticated, public;
revoke insert, update, delete on table public.zip_county_xref from anon, authenticated, public;
grant select on table public.fips_codes to authenticated;
grant select on table public.zip_county_xref to authenticated;
grant all on table public.fips_codes to service_role;
grant all on table public.zip_county_xref to service_role;

-- Function grant hygiene: guarded functions should not be exposed to anon.
revoke execute on function public.merge_duplicate_properties(uuid, uuid) from anon;

revoke execute on function public.get_oauth_token(uuid, text, text, text) from anon, authenticated, public;
revoke execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) from anon, authenticated, public;
revoke execute on function public.delete_oauth_tokens(uuid, text) from anon, authenticated, public;
grant execute on function public.get_oauth_token(uuid, text, text, text) to service_role;
grant execute on function public.upsert_oauth_token(uuid, text, text, text, text, timestamptz, text[], text, text) to service_role;
grant execute on function public.delete_oauth_tokens(uuid, text) to service_role;

-- Pin trigger function search_path values for schema-shadowing hardening.
do $$
begin
  if to_regprocedure('public.set_updated_at()') is not null then
    alter function public.set_updated_at()
      set search_path = '';
  end if;

  if to_regprocedure('public.saved_filters_set_updated_at()') is not null then
    alter function public.saved_filters_set_updated_at()
      set search_path = '';
  end if;
end;
$$;

commit;
