#!/usr/bin/env bash
set -euo pipefail

DNC_LOCK_TMP="$(mktemp -d /tmp/sandra-dnc-lock.XXXXXX)"
DNC_LOCK_PORT="$((35432 + RANDOM % 1000))"
DNC_LOCK_SOCKET="$DNC_LOCK_TMP/socket"
DNC_LOCK_MIGRATION="$(cd "$(dirname "$0")/.." && pwd)/supabase/migrations/20260815190000_true_dnc_property_lock.sql"
mkdir -p "$DNC_LOCK_SOCKET"

cleanup() {
  if [[ -f "$DNC_LOCK_TMP/data/postmaster.pid" ]]; then
    pg_ctl -D "$DNC_LOCK_TMP/data" -m immediate stop >/dev/null
  fi
  if [[ "$DNC_LOCK_TMP" == /tmp/sandra-dnc-lock.* ]]; then
    rm -rf -- "$DNC_LOCK_TMP"
  fi
}
trap cleanup EXIT

initdb -D "$DNC_LOCK_TMP/data" -A trust --no-locale -U postgres >/dev/null
pg_ctl -D "$DNC_LOCK_TMP/data" -o "-k $DNC_LOCK_SOCKET -p $DNC_LOCK_PORT" -w start >/dev/null
createdb -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres sandra_dnc_rehearsal

psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal <<'SQL'
create role anon;
create role authenticated;
create role service_role;

create table public.contacts (
  id uuid primary key,
  org_id uuid not null,
  first_name text,
  last_name text,
  entity_name text,
  do_not_contact boolean not null default false
);

create table public.properties (
  id uuid primary key,
  org_id uuid not null,
  address text not null,
  city text,
  state text not null,
  zip text,
  market text,
  status text not null,
  is_vacant boolean,
  cass_status text,
  absentee_flag boolean,
  assigned_user_id uuid,
  motivation_level text,
  outreach_dispo text,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  homeowner_contact_id uuid references public.contacts(id)
);

create table public.messages (
  id uuid primary key,
  property_id uuid references public.properties(id),
  direction text not null,
  read_at timestamptz
);

create table public.skip_trace_cache (
  id uuid primary key,
  org_id uuid not null,
  address_normalized text not null
);

create table public.tasks (
  id uuid primary key,
  org_id uuid,
  related_property_id uuid references public.properties(id),
  contact_id uuid references public.contacts(id)
);

create table public.lead_notes (
  id uuid primary key,
  property_id uuid references public.properties(id),
  body text
);

insert into public.contacts (id, org_id, first_name, do_not_contact) values
  ('10000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Locked', true),
  ('10000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Later', false),
  ('10000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Linked Locked', false),
  ('10000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Ordinary', false);

insert into public.properties
  (id, org_id, address, city, state, status, outreach_dispo, homeowner_contact_id)
values
  ('20000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '1 DNC St', 'Kansas City', 'MO', 'interested', 'dnc', null),
  ('20000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '2 DNC St', 'Kansas City', 'MO', 'closed', null, '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '3 Channel St', 'Kansas City', 'MO', 'under_contract', 'wrong_number', null),
  ('20000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '4 Channel St', 'Kansas City', 'MO', 'prospect', 'opted_out', null),
  ('20000000-0000-0000-0000-000000000005', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '5 Other Org St', 'Kansas City', 'MO', 'new_lead', null, '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '6 Later St', 'Kansas City', 'MO', 'offer_sent', null, '10000000-0000-0000-0000-000000000002'),
  ('20000000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '8 Linked Lock St', 'Kansas City', 'MO', 'closed', 'dnc', '10000000-0000-0000-0000-000000000003');

-- Historical children may already exist when migration backfills the lock.
-- They remain readable but cannot be detached/mutated afterward.
insert into public.tasks (id, org_id, related_property_id, contact_id) values
  ('30000000-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001');
insert into public.lead_notes (id, property_id, body) values
  ('60000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'Historical note');
SQL

psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal -f "$DNC_LOCK_MIGRATION" >/dev/null
psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal -f "$DNC_LOCK_MIGRATION" >/dev/null

psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal <<'SQL'
insert into public.properties
  (id, org_id, address, city, state, status, outreach_dispo)
select
  ('40000000-0000-0000-0000-' || lpad(stage.ordinality::text, 12, '0'))::uuid,
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,
  stage.ordinality || ' Every Stage St',
  'Kansas City',
  'MO',
  stage.status,
  'dnc'
from unnest(array[
  'new_lead', 'contacted', 'interested', 'offer_sent',
  'offer_declined', 'under_contract', 'closed', 'dead'
]) with ordinality as stage(status, ordinality);

do $$
begin
  if not exists (
    select 1 from public.properties
    where id = '20000000-0000-0000-0000-000000000001'
      and is_dnc_locked and status = 'interested'
  ) then raise exception 'disposition backfill changed or missed status'; end if;

  if not exists (
    select 1 from public.properties
    where id = '20000000-0000-0000-0000-000000000002'
      and is_dnc_locked and status = 'closed'
  ) then raise exception 'contact backfill changed or missed status'; end if;

  if exists (
    select 1 from public.properties
    where id in (
      '20000000-0000-0000-0000-000000000003',
      '20000000-0000-0000-0000-000000000004',
      '20000000-0000-0000-0000-000000000005'
    ) and is_dnc_locked
  ) then raise exception 'channel restriction or cross-org contact leaked into true DNC'; end if;

  if exists (
    select 1 from public.leads_board where is_dnc_locked
  ) then raise exception 'locked property leaked into leads_board'; end if;

  if (select count(*) from public.properties where id::text like '40000000-%' and is_dnc_locked) <> 8
  then raise exception 'not every Leads stage ratcheted out of the board'; end if;
end $$;

update public.contacts
set do_not_contact = true
where id = '10000000-0000-0000-0000-000000000002';

do $$
begin
  if not exists (
    select 1 from public.properties
    where id = '20000000-0000-0000-0000-000000000006'
      and is_dnc_locked and status = 'offer_sent'
  ) then raise exception 'contact ratchet did not preserve status'; end if;

  begin
    update public.contacts set do_not_contact = false
    where id = '10000000-0000-0000-0000-000000000002';
    raise exception 'contact DNC unexpectedly cleared';
  exception when sqlstate 'P0001' then null;
  end;

  begin
    update public.tasks
    set related_property_id = '20000000-0000-0000-0000-000000000003',
        contact_id = '10000000-0000-0000-0000-000000000004'
    where id = '30000000-0000-0000-0000-000000000008';
    raise exception 'locked task unexpectedly detached from property/contact';
  exception when sqlstate 'P0001' then null;
  end;

  begin
    update public.lead_notes
    set property_id = '20000000-0000-0000-0000-000000000003',
        body = 'Mutated while detached'
    where id = '60000000-0000-0000-0000-000000000001';
    raise exception 'locked note unexpectedly detached and mutated';
  exception when sqlstate 'P0001' then null;
  end;

  begin
    update public.properties set is_dnc_locked = false
    where id = '20000000-0000-0000-0000-000000000006';
    raise exception 'property DNC unexpectedly cleared';
  exception when sqlstate 'P0001' then null;
  end;

  begin
    update public.properties set status = 'closed'
    where id = '20000000-0000-0000-0000-000000000006';
    raise exception 'locked property unexpectedly mutated';
  exception when sqlstate 'P0001' then null;
  end;

  begin
    insert into public.tasks (id, related_property_id) values
      ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000006');
    raise exception 'locked property unexpectedly accepted a task';
  exception when sqlstate 'P0001' then null;
  end;

  begin
    insert into public.tasks (id, org_id, contact_id) values
      ('30000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '10000000-0000-0000-0000-000000000001');
    raise exception 'contact-only true DNC unexpectedly accepted a task';
  exception when sqlstate 'P0001' then null;
  end;

  begin
    insert into public.tasks (id, org_id, contact_id) values
      ('30000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '10000000-0000-0000-0000-000000000003');
    raise exception 'contact linked to locked property unexpectedly accepted a task';
  exception when sqlstate 'P0001' then null;
  end;
end $$;

insert into public.tasks (id, org_id, contact_id) values
  ('30000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '10000000-0000-0000-0000-000000000004');

insert into public.messages (id, property_id, direction, read_at) values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'inbound', null);

do $$
begin
  begin
    update public.messages
    set property_id = '20000000-0000-0000-0000-000000000003',
        read_at = now()
    where id = '50000000-0000-0000-0000-000000000001';
    raise exception 'locked message unexpectedly detached and acknowledged';
  exception when sqlstate 'P0001' then null;
  end;
end $$;

insert into public.properties
  (id, org_id, address, city, state, status, outreach_dispo)
values
  ('20000000-0000-0000-0000-000000000007', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '7 Race St', 'Kansas City', 'MO', 'new_lead', null);

update public.properties
set status = 'under_contract', outreach_dispo = 'dnc'
where id = '20000000-0000-0000-0000-000000000007';

do $$
begin
  if not exists (
    select 1 from public.properties
    where id = '20000000-0000-0000-0000-000000000007'
      and is_dnc_locked and status = 'new_lead'
  ) then raise exception 'DNC/status race did not preserve historical status'; end if;
end $$;
SQL

# Two real transactions: the DNC writer takes the property row first and holds
# it. The sidecar insert must wait, then re-check and fail after DNC commits.
psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal -c \
  "insert into public.properties (id, org_id, address, state, status) values ('20000000-0000-0000-0000-000000000009','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','9 Concurrent St','MO','new_lead')" >/dev/null
psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal -c \
  "begin; update public.properties set outreach_dispo='dnc' where id='20000000-0000-0000-0000-000000000009'; select pg_sleep(2); commit" >/dev/null &
DNC_WRITER_PID=$!
sleep 0.5
if psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal -c \
  "insert into public.tasks (id, related_property_id) values ('30000000-0000-0000-0000-000000000009','20000000-0000-0000-0000-000000000009')" >/dev/null 2>&1; then
  echo "concurrent sidecar mutation unexpectedly committed" >&2
  exit 1
fi
wait "$DNC_WRITER_PID"

# Same concurrency boundary for contact-derived DNC. The contact transaction
# holds CONTACT then PROPERTY; the task trigger follows the same order, waits,
# and rejects after the permanent lock commits instead of deadlocking.
psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal <<'SQL' >/dev/null
insert into public.contacts (id, org_id, first_name, do_not_contact) values
  ('10000000-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Concurrent Contact', false);
insert into public.properties
  (id, org_id, address, state, status, homeowner_contact_id)
values
  ('20000000-0000-0000-0000-000000000010', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '10 Contact Race St', 'MO', 'new_lead', '10000000-0000-0000-0000-000000000005');
SQL
psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal -c \
  "begin; update public.contacts set do_not_contact=true where id='10000000-0000-0000-0000-000000000005'; select pg_sleep(2); commit" >/dev/null &
CONTACT_DNC_WRITER_PID=$!
sleep 0.5
if psql -v ON_ERROR_STOP=1 -h "$DNC_LOCK_SOCKET" -p "$DNC_LOCK_PORT" -U postgres -d sandra_dnc_rehearsal -c \
  "insert into public.tasks (id, org_id, related_property_id, contact_id) values ('30000000-0000-0000-0000-000000000010','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','20000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000005')" >/dev/null 2>&1; then
  echo "contact DNC race unexpectedly accepted a late task" >&2
  exit 1
fi
wait "$CONTACT_DNC_WRITER_PID"

echo "true-DNC migration rehearsal passed"
