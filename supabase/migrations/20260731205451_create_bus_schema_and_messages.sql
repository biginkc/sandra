create schema if not exists bus;

create table if not exists bus.bus_messages (
  id uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  source text not null,
  target text not null,
  priority text not null default 'P1'::text,
  body jsonb not null,
  status text not null default 'new'::text,
  external_ref text null,
  result jsonb null
);

create unique index if not exists bus_messages_pkey
  on bus.bus_messages using btree (id);

create unique index if not exists bus_messages_source_ref_uq
  on bus.bus_messages using btree (source, external_ref)
  where (external_ref is not null);

do $add_bus_messages_primary_key$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'bus.bus_messages'::regclass
      and conname = 'bus_messages_pkey'
  ) then
    alter table bus.bus_messages
      add constraint bus_messages_pkey primary key using index bus_messages_pkey;
  end if;
end
$add_bus_messages_primary_key$;

do $add_bus_messages_status_check$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'bus.bus_messages'::regclass
      and conname = 'bus_messages_status_check'
  ) then
    alter table bus.bus_messages
      add constraint bus_messages_status_check
      check ((status = any (array['new', 'processing', 'done', 'error'])));
  end if;
end
$add_bus_messages_status_check$;

alter table bus.bus_messages enable row level security;

revoke all on table bus.bus_messages from public, anon, authenticated, service_role;
grant insert, select, update, delete, truncate, references, trigger
  on table bus.bus_messages to postgres;
