#!/usr/bin/env bash
set -euo pipefail

LEADS_TMP="$(mktemp -d /tmp/sandra-leads-urgency.XXXXXX)"
LEADS_PORT="$((37432 + RANDOM % 1000))"
LEADS_SOCKET="$LEADS_TMP/socket"
LEADS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEADS_MIGRATION="$LEADS_ROOT/supabase/migrations/20260815233000_leads_urgency_paging.sql"
LEADS_SAFETY_MIGRATION="$LEADS_ROOT/supabase/migrations/20260816030000_leads_tenant_paging_safety.sql"
LEADS_DNC_MIGRATION="$LEADS_ROOT/supabase/migrations/20260815190000_true_dnc_property_lock.sql"
mkdir -p "$LEADS_SOCKET"

cleanup() {
  if [[ -f "$LEADS_TMP/data/postmaster.pid" ]]; then
    pg_ctl -D "$LEADS_TMP/data" -m immediate stop >/dev/null
  fi
  if [[ "$LEADS_TMP" == /tmp/sandra-leads-urgency.* ]]; then
    rm -rf -- "$LEADS_TMP"
  fi
}
trap cleanup EXIT

initdb -D "$LEADS_TMP/data" -A trust --no-locale -U postgres >/dev/null
pg_ctl -D "$LEADS_TMP/data" -o "-k $LEADS_SOCKET -p $LEADS_PORT" -w start >/dev/null
createdb -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres sandra_leads_rehearsal

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
create extension if not exists pgcrypto;
create role anon;
create role authenticated;
create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to authenticated, service_role;
grant execute on function auth.uid() to authenticated, service_role;

create table public.memberships (
  user_id uuid not null, org_id uuid not null,
  access_status text not null default 'active', access_expires_at timestamptz,
  primary key(user_id, org_id)
);
create table public.contacts (
  id uuid primary key, org_id uuid not null, first_name text, last_name text,
  entity_name text, do_not_contact boolean not null default false
);
create table public.properties (
  id uuid primary key, org_id uuid not null, address text not null, city text,
  state text not null, zip text, market text, status text not null,
  is_vacant boolean, cass_status text, absentee_flag boolean,
  assigned_user_id uuid, motivation_level text, outreach_dispo text,
  is_dnc_locked boolean not null default false, deleted_at timestamptz,
  created_at timestamptz not null default now(), homeowner_contact_id uuid
);
create table public.messages (
  id uuid primary key default gen_random_uuid(), property_id uuid, direction text,
  body text, read_at timestamptz, created_at timestamptz not null default now()
);
create table public.sequence_enrollments (
  id uuid primary key default gen_random_uuid(), property_id uuid, status text,
  completed_at timestamptz
);
create table public.skip_trace_cache (id uuid primary key default gen_random_uuid(), org_id uuid, address_normalized text);
create table public.tasks (
  id uuid primary key default gen_random_uuid(), org_id uuid not null,
  assignee_id uuid not null, related_property_id uuid, contact_id uuid,
  type text not null, status text not null default 'open', title text not null,
  due_at timestamptz not null, created_by uuid not null,
  created_at timestamptz not null default now()
);
create table public.property_lists (property_id uuid, list_id uuid);
create table public.property_tags (property_id uuid, tag_id uuid);

alter table public.memberships enable row level security;
alter table public.contacts enable row level security;
alter table public.properties enable row level security;
alter table public.messages enable row level security;
alter table public.sequence_enrollments enable row level security;
alter table public.skip_trace_cache enable row level security;
alter table public.tasks enable row level security;

create policy member_memberships on memberships to authenticated using (user_id = auth.uid());
create policy member_contacts on contacts to authenticated using (exists (select 1 from memberships m where m.org_id=contacts.org_id and m.user_id=auth.uid()));
create policy member_properties on properties to authenticated using (exists (select 1 from memberships m where m.org_id=properties.org_id and m.user_id=auth.uid()));
create policy member_messages on messages to authenticated using (exists (select 1 from properties p where p.id=messages.property_id));
create policy member_sequences on sequence_enrollments to authenticated using (exists (select 1 from properties p where p.id=sequence_enrollments.property_id));
create policy member_skip on skip_trace_cache to authenticated using (exists (select 1 from memberships m where m.org_id=skip_trace_cache.org_id and m.user_id=auth.uid()));
create policy member_tasks on tasks to authenticated using (exists (select 1 from memberships m where m.org_id=tasks.org_id and m.user_id=auth.uid())) with check (exists (select 1 from memberships m where m.org_id=tasks.org_id and m.user_id=auth.uid()));

grant select on all tables in schema public to authenticated;
grant insert, update on public.tasks to authenticated;
grant update on public.properties, public.contacts to authenticated;
grant usage, select on all sequences in schema public to authenticated;

insert into memberships values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into contacts values
 ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A','Owner',null,false),
 ('bbbbbbbb-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B','Owner',null,false);
insert into properties (id,org_id,address,city,state,status,homeowner_contact_id,created_at) values
 ('aaaaaaaa-1000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','1 Overdue St','Kansas City','MO','new_lead','aaaaaaaa-0000-4000-8000-000000000001','2026-01-01'),
 ('aaaaaaaa-1000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2 Today St','Kansas City','MO','new_lead','aaaaaaaa-0000-4000-8000-000000000001','2026-01-02'),
 ('aaaaaaaa-1000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','3 No Task St','Kansas City','MO','new_lead','aaaaaaaa-0000-4000-8000-000000000001','2026-01-03'),
 ('aaaaaaaa-1000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','4 Locked St','Kansas City','MO','interested','aaaaaaaa-0000-4000-8000-000000000001','2026-01-04'),
 ('bbbbbbbb-1000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Other Org St','Kansas City','MO','new_lead','bbbbbbbb-0000-4000-8000-000000000001','2026-01-01');
update properties set outreach_dispo='dnc' where id='aaaaaaaa-1000-4000-8000-000000000004';
insert into tasks (id,org_id,assignee_id,related_property_id,type,status,title,due_at,created_by) values
 ('aaaaaaaa-2000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-1000-4000-8000-000000000001','follow_up','open','Later duplicate','2026-08-14 12:00Z','11111111-1111-4111-8111-111111111111'),
 ('aaaaaaaa-2000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-1000-4000-8000-000000000001','follow_up','open','Earliest','2026-08-13 12:00Z','11111111-1111-4111-8111-111111111111'),
 ('aaaaaaaa-2000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-1000-4000-8000-000000000002','follow_up','open','Today','2026-08-15 15:00Z','11111111-1111-4111-8111-111111111111');
insert into messages (property_id,direction,body,created_at) values
 ('aaaaaaaa-1000-4000-8000-000000000002','inbound','Still waiting',now()-interval '8 days');
insert into sequence_enrollments (property_id,status,completed_at) values
 ('aaaaaaaa-1000-4000-8000-000000000001','completed',now()-interval '2 days'),
 ('aaaaaaaa-1000-4000-8000-000000000003','active',null);
SQL

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal -f "$LEADS_DNC_MIGRATION" >/dev/null
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal -f "$LEADS_MIGRATION" >/dev/null
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal -f "$LEADS_MIGRATION" >/dev/null
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal -f "$LEADS_SAFETY_MIGRATION" >/dev/null
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal -f "$LEADS_SAFETY_MIGRATION" >/dev/null

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ begin
  if (select next_task_title from leads_board where id='aaaaaaaa-1000-4000-8000-000000000001') <> 'Earliest'
  then raise exception 'earliest open task projection is not deterministic'; end if;
  if exists (select 1 from leads_board where is_dnc_locked)
  then raise exception 'locked lead leaked'; end if;
  if exists (select 1 from leads_board where address='Other Org St')
  then raise exception 'other org leaked through security-invoker view'; end if;
  if not (select is_stale from leads_board where id='aaaaaaaa-1000-4000-8000-000000000002')
  then raise exception 'stale dashboard semantic was not projected'; end if;
  if not (select sequence_ended_without_follow_up from leads_board where id='aaaaaaaa-1000-4000-8000-000000000001')
  then raise exception 'sequence-ended semantic was not projected'; end if;
  if not (select has_active_sequence from leads_board where id='aaaaaaaa-1000-4000-8000-000000000003')
  then raise exception 'active-sequence semantic was not projected'; end if;
end $$;
reset role;
SQL

# Equal-count swap: one card leaves before the cursor while another enters in
# its place. Count-only detection misses this; the whole-filter fingerprint
# must change so the client replaces the board rather than appending stale data.
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
insert into properties (id,org_id,address,city,state,status,created_at) values
 ('aaaaaaaa-1000-4000-8000-000000000021','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','21 Swap Out','Kansas City','MO','offer_sent','2026-01-21'),
 ('aaaaaaaa-1000-4000-8000-000000000022','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22 Stable Tail','Kansas City','MO','offer_sent','2026-01-22'),
 ('aaaaaaaa-1000-4000-8000-000000000023','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','23 Swap In','Kansas City','MO','contacted','2026-01-23');
insert into tasks (id,org_id,assignee_id,related_property_id,type,status,title,due_at,created_by) values
 ('aaaaaaaa-2000-4000-8000-000000000021','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-1000-4000-8000-000000000021','follow_up','open','Swap out','2026-08-10 12:00Z','11111111-1111-4111-8111-111111111111'),
 ('aaaaaaaa-2000-4000-8000-000000000022','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-1000-4000-8000-000000000022','follow_up','open','Stable tail','2026-08-11 12:00Z','11111111-1111-4111-8111-111111111111'),
 ('aaaaaaaa-2000-4000-8000-000000000023','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-1000-4000-8000-000000000023','follow_up','open','Swap in','2026-08-09 12:00Z','11111111-1111-4111-8111-111111111111');
set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
create temp table swap_first as
  select rows, total_count, snapshot_generation
  from get_leads_board_page(
    'offer_sent', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z',
    null, null, 1
  );
reset role;
update properties set status='contacted' where id='aaaaaaaa-1000-4000-8000-000000000021';
update properties set status='offer_sent' where id='aaaaaaaa-1000-4000-8000-000000000023';
set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
create temp table swap_second as
  select page.rows, page.total_count, page.snapshot_generation
  from swap_first first,
  lateral get_leads_board_page(
    'offer_sent', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z',
    (first.rows -> -1 ->> 'next_task_due_at')::timestamptz,
    (first.rows -> -1 ->> 'id')::uuid,
    2
  ) page;
do $$ begin
  if (select total_count from swap_first) <> (select total_count from swap_second)
  then raise exception 'equal-count swap did not preserve count'; end if;
  if (select snapshot_generation from swap_first) = (select snapshot_generation from swap_second)
  then raise exception 'equal-count swap did not change snapshot fingerprint'; end if;
end $$;
reset role;
SQL

# The application pre-check gives a friendly error; this database trigger is
# the race-closing authority immediately when assigned_user_id is written.
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
insert into memberships (user_id,org_id,access_status,access_expires_at) values
 ('11111111-1111-4111-8111-111111111112','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',null),
 ('11111111-1111-4111-8111-111111111113','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','suspended',null),
 ('11111111-1111-4111-8111-111111111114','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',now()-interval '1 minute');
update properties set assigned_user_id='11111111-1111-4111-8111-111111111112'
where id='aaaaaaaa-1000-4000-8000-000000000002';
do $$ begin
  begin
    update properties set assigned_user_id='11111111-1111-4111-8111-111111111113'
    where id='aaaaaaaa-1000-4000-8000-000000000002';
    raise exception 'suspended assignee unexpectedly accepted';
  exception when check_violation then
    if sqlerrm not like 'INVALID_ASSIGNEE:%' then raise; end if;
  end;
  begin
    update properties set assigned_user_id='11111111-1111-4111-8111-111111111114'
    where id='aaaaaaaa-1000-4000-8000-000000000002';
    raise exception 'expired assignee unexpectedly accepted';
  exception when check_violation then
    if sqlerrm not like 'INVALID_ASSIGNEE:%' then raise; end if;
  end;
  begin
    update properties set assigned_user_id='22222222-2222-4222-8222-222222222222'
    where id='aaaaaaaa-1000-4000-8000-000000000002';
    raise exception 'other-org assignee unexpectedly accepted';
  exception when check_violation then
    if sqlerrm not like 'INVALID_ASSIGNEE:%' then raise; end if;
  end;
end $$;
update properties set assigned_user_id=null
where id='aaaaaaaa-1000-4000-8000-000000000002';
SQL

# Two concurrent inline Set calls use different request keys but one property
# row lock. Exactly one open task is created; the waiter returns that row.
(
  psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
begin; set local role authenticated; set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
select id from set_lead_next_action('aaaaaaaa-1000-4000-8000-000000000003','2026-08-16 14:00Z','aaaaaaaa-3000-4000-8000-000000000001');
select pg_sleep(1); commit;
SQL
) >/dev/null &
FIRST_PID=$!
(
  psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
select id from set_lead_next_action('aaaaaaaa-1000-4000-8000-000000000003','2026-08-17 14:00Z','aaaaaaaa-3000-4000-8000-000000000002');
SQL
) >/dev/null &
SECOND_PID=$!
wait "$FIRST_PID" "$SECOND_PID"

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
do $$ begin
  if (select count(*) from tasks where related_property_id='aaaaaaaa-1000-4000-8000-000000000003' and status='open') <> 1
  then raise exception 'concurrent Set created duplicate open tasks'; end if;
end $$;

-- The page RPC returns rows and its pre-cursor exact total from one statement.
-- A stable two-page traversal must converge exactly to that snapshot total.
set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
create temp table stable_first as
  select rows, total_count
  from get_leads_board_page(
    'new_lead', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z',
    null, null, 2
  );
create temp table stable_second as
  select page.rows, page.total_count
  from stable_first first,
  lateral get_leads_board_page(
    'new_lead', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z',
    (first.rows -> -1 ->> 'next_task_due_at')::timestamptz,
    (first.rows -> -1 ->> 'id')::uuid,
    2
  ) page;
do $$ declare first_total bigint; first_rows integer; second_total bigint; second_rows integer; begin
  select total_count, jsonb_array_length(rows) into first_total, first_rows from stable_first;
  select total_count, jsonb_array_length(rows) into second_total, second_rows from stable_second;
  if (select total_count from stable_first) <> 3
    or jsonb_array_length((select rows from stable_first)) <> 2
    or jsonb_array_length((select rows from stable_second)) <> 1
    or (select total_count from stable_second) <> 3
  then raise exception 'stable keyset traversal did not converge: total/rows %/%, %/%, first=% second=%', first_total, first_rows, second_total, second_rows, (select rows from stable_first), (select rows from stable_second); end if;
end $$;

-- A concurrent insertion before the cursor is intentionally not spliced into
-- the old traversal. The next RPC truthfully reports the changed count, which
-- is the client's explicit refresh signal rather than a false 39/40 finish.
create temp table first_page as
  select rows, total_count
  from get_leads_board_page(
    'new_lead', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z',
    null, null, 1
  );
reset role;
insert into properties (id,org_id,address,city,state,status,created_at)
values ('aaaaaaaa-1000-4000-8000-000000000009','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Inserted Before Cursor','Kansas City','MO','new_lead','2026-01-09');
insert into tasks (id,org_id,assignee_id,related_property_id,type,status,title,due_at,created_by)
values ('aaaaaaaa-2000-4000-8000-000000000009','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','aaaaaaaa-1000-4000-8000-000000000009','follow_up','open','Inserted Earlier','2026-08-12 12:00Z','11111111-1111-4111-8111-111111111111');
set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
create temp table page_after_insert as
  select page.rows, page.total_count
  from first_page first,
  lateral get_leads_board_page(
    'new_lead', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z',
    (first.rows -> -1 ->> 'next_task_due_at')::timestamptz,
    (first.rows -> -1 ->> 'id')::uuid,
    101
  ) page;
do $$ begin
  if (select total_count from page_after_insert) <> (select total_count from first_page) + 1
  then raise exception 'concurrent insert did not expose a changed-count refresh signal'; end if;
  if (select rows from page_after_insert) @> (select rows from first_page)
  then raise exception 'keyset page duplicated the cursor row'; end if;
end $$;
reset role;
SQL

# Direct authenticated RPC calls cannot disable the page bound with NULL,
# zero, or an oversized limit.
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
insert into properties (id,org_id,address,city,state,status)
select gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Bounded ' || n || ' St', 'Kansas City', 'MO', 'contacted'
from generate_series(1,105) n;
set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ declare null_rows integer; zero_rows integer; oversized_rows integer; begin
  select jsonb_array_length(rows) into null_rows from get_leads_board_page(
    'contacted', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z', null, null, null
  );
  select jsonb_array_length(rows) into zero_rows from get_leads_board_page(
    'contacted', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z', null, null, 0
  );
  select jsonb_array_length(rows) into oversized_rows from get_leads_board_page(
    'contacted', null, false, array[]::text[], 'all', 'all', null,
    false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z', null, null, 1000
  );
  if null_rows <> 1 or zero_rows <> 1 or oversized_rows <> 101
  then raise exception 'page bound bypassed: null %, zero %, oversized %', null_rows, zero_rows, oversized_rows; end if;
end $$;
reset role;
SQL

# Exercise the real true-DNC contact/property/task triggers in both lock
# orders. These rows are isolated from the paging fixtures above.
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
insert into contacts (id,org_id,first_name,do_not_contact) values
 ('aaaaaaaa-0000-4000-8000-000000000011','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Set First',false),
 ('aaaaaaaa-0000-4000-8000-000000000012','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','DNC First',false);
insert into properties (id,org_id,address,city,state,status,homeowner_contact_id) values
 ('aaaaaaaa-1000-4000-8000-000000000011','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11 Set First St','Kansas City','MO','contacted','aaaaaaaa-0000-4000-8000-000000000011'),
 ('aaaaaaaa-1000-4000-8000-000000000012','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','12 DNC First St','Kansas City','MO','contacted','aaaaaaaa-0000-4000-8000-000000000012');
SQL

# SET wins the property lock first: its task is legal, then DNC ratchets.
(
  psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
begin; set local role authenticated; set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
select id from set_lead_next_action('aaaaaaaa-1000-4000-8000-000000000011','2026-08-20 14:00Z','aaaaaaaa-3000-4000-8000-000000000011');
select pg_sleep(0.75); commit;
SQL
) >/dev/null &
SET_FIRST_PID=$!
sleep 0.15
(
  psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
update contacts set do_not_contact=true where id='aaaaaaaa-0000-4000-8000-000000000011';
SQL
) >/dev/null &
DNC_WAITER_PID=$!
wait "$SET_FIRST_PID" "$DNC_WAITER_PID"

# DNC wins first: the waiting Set must reject and create no task.
(
  psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
begin; set local role authenticated; set local request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
update contacts set do_not_contact=true where id='aaaaaaaa-0000-4000-8000-000000000012';
select pg_sleep(0.75); commit;
SQL
) >/dev/null &
DNC_FIRST_PID=$!
sleep 0.15
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL' >/dev/null
set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ begin
  perform id from set_lead_next_action('aaaaaaaa-1000-4000-8000-000000000012','2026-08-20 14:00Z','aaaaaaaa-3000-4000-8000-000000000012');
  raise exception 'Set unexpectedly succeeded after DNC won';
exception when sqlstate 'P0001' then
  if sqlerrm not like 'DNC_LOCKED:%' then raise; end if;
end $$;
SQL
wait "$DNC_FIRST_PID"

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$ declare replayed uuid; begin
  if (select count(*) from tasks where related_property_id='aaaaaaaa-1000-4000-8000-000000000011') <> 1
  then raise exception 'Set-first race did not produce exactly one legal task'; end if;
  if exists (select 1 from tasks where related_property_id='aaaaaaaa-1000-4000-8000-000000000012')
  then raise exception 'DNC-first race created a late task'; end if;

  -- A response-lost replay remains truthful after DNC ratchets.
  select id into replayed from set_lead_next_action(
    'aaaaaaaa-1000-4000-8000-000000000011',
    '2026-08-20 14:00Z',
    'aaaaaaaa-3000-4000-8000-000000000011'
  );
  if replayed is null then raise exception 'same-key replay after DNC returned no task'; end if;

  begin
    perform id from set_lead_next_action(
      'aaaaaaaa-1000-4000-8000-000000000011',
      '2026-08-21 14:00Z',
      'aaaaaaaa-3000-4000-8000-000000000011'
    );
    raise exception 'changed-payload replay unexpectedly succeeded';
  exception when sqlstate '22023' then
    if sqlerrm not like 'IDEMPOTENCY_KEY_CONFLICT:%' then raise; end if;
  end;
end $$;
reset role;
SQL

echo "Leads urgency/paging migration rehearsal passed (real DNC triggers, apply/replay, multi-org, assignment membership, projection, concurrency, exact page/count, and equal-count fingerprint refresh signal)."
