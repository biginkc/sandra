#!/usr/bin/env bash
set -euo pipefail

LEADS_TMP="$(mktemp -d /tmp/sandra-leads-urgency.XXXXXX)"
LEADS_PORT="$((37432 + RANDOM % 1000))"
LEADS_SOCKET="$LEADS_TMP/socket"
LEADS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LEADS_MIGRATION="$LEADS_ROOT/supabase/migrations/20260815233000_leads_urgency_paging.sql"
LEADS_SAFETY_MIGRATION="$LEADS_ROOT/supabase/migrations/20260816030000_leads_tenant_paging_safety.sql"
LEADS_DNC_MIGRATION="$LEADS_ROOT/supabase/migrations/20260815190000_true_dnc_property_lock.sql"
LEADS_URGENCY_TIMEOUT_MIGRATION="$LEADS_ROOT/supabase/migrations/20260830103000_leads_urgency_counts_timeout_fix.sql"
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
  entity_name text, do_not_contact boolean not null default false,
  sms_opted_out boolean not null default false
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
create table public.skip_trace_cache (
  id uuid primary key default gen_random_uuid(), provider text not null,
  address_normalized text not null, result jsonb not null,
  match_count integer not null default 0, cost_credits integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index idx_skip_trace_cache_unique on public.skip_trace_cache(provider, address_normalized);
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
create policy skip_trace_cache_authenticated_select on skip_trace_cache to authenticated using (true);
create policy skip_trace_cache_service_write on skip_trace_cache for all to service_role using (true) with check (true);
create policy member_tasks on tasks to authenticated using (exists (select 1 from memberships m where m.org_id=tasks.org_id and m.user_id=auth.uid())) with check (exists (select 1 from memberships m where m.org_id=tasks.org_id and m.user_id=auth.uid()));

grant select on all tables in schema public to authenticated;
grant insert, update on public.tasks to authenticated;
grant update on public.properties, public.contacts to authenticated;
grant usage, select on all sequences in schema public to authenticated;

insert into memberships values
 ('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
 ('22222222-2222-4222-8222-222222222222','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
insert into contacts values
 ('aaaaaaaa-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','A','Owner',null,false,false),
 ('aaaaaaaa-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','SMS','Only',null,false,true),
 ('bbbbbbbb-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','B','Owner',null,false,false);
insert into properties (id,org_id,address,city,state,status,homeowner_contact_id,created_at) values
 ('aaaaaaaa-1000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','1 Overdue St','Kansas City','MO','new_lead','aaaaaaaa-0000-4000-8000-000000000001','2026-01-01'),
 ('aaaaaaaa-1000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','2 Today St','Kansas City','MO','new_lead','aaaaaaaa-0000-4000-8000-000000000001','2026-01-02'),
 ('aaaaaaaa-1000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','3 No Task St','Kansas City','MO','new_lead','aaaaaaaa-0000-4000-8000-000000000001','2026-01-03'),
 ('aaaaaaaa-1000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','4 Locked St','Kansas City','MO','interested','aaaaaaaa-0000-4000-8000-000000000001','2026-01-04'),
 ('aaaaaaaa-1000-4000-8000-000000000005','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','5 SMS Only St','Kansas City','MO','prospect','aaaaaaaa-0000-4000-8000-000000000002','2026-01-05'),
 ('bbbbbbbb-1000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Other Org St','Kansas City','MO','new_lead','bbbbbbbb-0000-4000-8000-000000000001','2026-01-01');
update properties set outreach_dispo='dnc' where id='aaaaaaaa-1000-4000-8000-000000000004';
update properties set outreach_dispo='opted_out' where id='aaaaaaaa-1000-4000-8000-000000000005';
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
-- Promotion changes only the pipeline stage. An SMS-only restriction remains
-- on the record, but it must not make the new lead disappear from the board.
update properties set status='new_lead'
where id='aaaaaaaa-1000-4000-8000-000000000005';
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
  if not exists (
    select 1
    from get_leads_board_page(
      'new_lead', null, false, array[]::text[], 'all', 'all', null,
      false, false, null, '2026-08-15 05:00Z', '2026-08-16 05:00Z',
      null, null, 100
    ) page
    where page.rows @> '[{"id":"aaaaaaaa-1000-4000-8000-000000000005"}]'::jsonb
  ) then raise exception 'SMS-only opted-out promotion disappeared from page query'; end if;
  if not exists (
    select 1 from get_leads_board_stage_counts()
    where status='new_lead' and total_count=4
  ) then raise exception 'SMS-only opted-out promotion missing from stage count'; end if;
  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array[]::text[], 'all', null, false, false, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=4
  ) then raise exception 'SMS-only opted-out promotion missing from urgency count'; end if;
  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array[]::text[], 'all', null, false, null, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=3
  ) then raise exception 'pre-fix nullable active-sequence semantics changed'; end if;
end $$;
reset role;
SQL

# Build a mutation-sensitive matrix for every optional urgency filter. The same
# authenticated rows are captured before and after the forward replacement so
# semantic drift cannot hide behind a single default-count assertion.
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL' >/dev/null
insert into memberships values
 ('33333333-3333-4333-8333-333333333333','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
update properties
set assigned_user_id='11111111-1111-4111-8111-111111111111', motivation_level=null
where id='aaaaaaaa-1000-4000-8000-000000000001';
update properties
set assigned_user_id='33333333-3333-4333-8333-333333333333', motivation_level='high'
where id='aaaaaaaa-1000-4000-8000-000000000002';
update properties set motivation_level='low'
where id='aaaaaaaa-1000-4000-8000-000000000003';
insert into properties (id,org_id,address,city,state,status,created_at) values
 ('aaaaaaaa-1000-4000-8000-000000000031','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','6 Closed St','Kansas City','MO','closed','2026-01-06'),
 ('aaaaaaaa-1000-4000-8000-000000000032','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','7 Wrong New St','Kansas City','MO','new_lead','2026-01-07'),
 ('aaaaaaaa-1000-4000-8000-000000000033','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','8 Wrong Hot St','Kansas City','MO','interested','2026-01-08'),
 ('aaaaaaaa-1000-4000-8000-000000000034','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','9 Bad Contacted St','Kansas City','MO','contacted','2026-01-09');
update properties set outreach_dispo='wrong_number'
where id in ('aaaaaaaa-1000-4000-8000-000000000032','aaaaaaaa-1000-4000-8000-000000000033');
update properties set outreach_dispo='bad_number'
where id='aaaaaaaa-1000-4000-8000-000000000034';
insert into skip_trace_cache (provider,address_normalized,result,match_count,cost_credits,org_id)
values ('rehearsal','1 overdue st|kansas city|mo','{}',1,0,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

create table urgency_filter_cases (
  case_name text primary key,
  assignee_id uuid,
  unassigned boolean not null,
  search_tokens text[] not null,
  motivation text not null,
  hot_only boolean not null,
  no_active_sequence boolean,
  skip_traced boolean,
  expected_all bigint not null,
  expected_overdue bigint not null,
  expected_today bigint not null,
  expected_scheduled bigint not null,
  expected_none bigint not null
);
insert into urgency_filter_cases values
 ('assignee_hit','11111111-1111-4111-8111-111111111111',false,'{}','all',false,false,null,1,1,0,0,0),
 ('assignee_miss','44444444-4444-4444-8444-444444444444',false,'{}','all',false,false,null,0,0,0,0,0),
 ('unassigned_excludes_closed',null,true,'{}','all',false,false,null,3,0,0,0,3),
 ('motivation_unset',null,false,'{}','unset',false,false,null,4,1,0,0,3),
 ('motivation_concrete',null,false,'{}','high',false,false,null,1,0,1,0,0),
 ('hot_hit',null,false,'{}','all',true,false,null,1,0,0,0,1),
 ('hot_miss','11111111-1111-4111-8111-111111111111',false,'{}','all',true,false,null,0,0,0,0,0),
 ('skip_traced_true',null,false,'{}','all',false,false,true,1,1,0,0,0),
 ('skip_traced_false',null,false,'{}','all',false,false,false,5,0,1,0,4),
 ('cross_org',null,false,array['Other','Org'],'all',false,false,null,0,0,0,0,0),
 ('dnc_locked',null,false,array['Locked'],'all',false,false,null,0,0,0,0,0),
 ('wrong_new_excluded',null,false,array['Wrong','New'],'all',false,false,null,0,0,0,0,0),
 ('bad_contacted_excluded',null,false,array['Bad','Contacted'],'all',false,false,null,0,0,0,0,0),
 ('wrong_hot_allowed',null,false,array['Wrong','Hot'],'all',false,false,null,1,0,0,0,1),
 ('nullable_active_sequence',null,false,'{}','all',false,null,null,5,1,1,0,3),
 ('false_active_sequence',null,false,'{}','all',false,false,null,6,1,1,0,4);
grant select on urgency_filter_cases to authenticated;
SQL

capture_filter_matrix() {
  local output_file="$1"
  : >"$output_file"
  while IFS= read -r matrix_case; do
    if [[ ! "$matrix_case" =~ ^[a-z_]+$ ]]; then
      echo "invalid urgency filter matrix case name" >&2
      exit 1
    fi
    psql -v ON_ERROR_STOP=1 -At -F '|' \
      -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal \
      -c "set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'; select c.case_name,r.all_count,r.overdue_count,r.today_count,r.scheduled_count,r.no_action_count from urgency_filter_cases c cross join lateral get_leads_board_urgency_counts(c.assignee_id,c.unassigned,c.search_tokens,c.motivation,null,c.hot_only,c.no_active_sequence,c.skip_traced,'2026-08-15 05:00Z','2026-08-16 05:00Z') r where c.case_name='$matrix_case';" \
      >>"$output_file"
  done < <(
    psql -v ON_ERROR_STOP=1 -At -h "$LEADS_SOCKET" -p "$LEADS_PORT" \
      -U postgres -d sandra_leads_rehearsal \
      -c "select case_name from urgency_filter_cases order by case_name"
  )
}

OLD_FILTER_MATRIX="$LEADS_TMP/old-filter-matrix.out"
capture_filter_matrix "$OLD_FILTER_MATRIX"

# Reproduce the production failure shape before applying the forward fix: the
# default urgency request must not expand every expensive leads_board column.
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL' >/dev/null
insert into properties (id,org_id,address,city,state,status,created_at)
select gen_random_uuid(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'Timeout fixture ' || n, 'Kansas City', 'MO', 'contacted', now()
from generate_series(1,500000) n;
insert into messages (property_id,direction,body,created_at)
select property.id,
  case when message_number % 2 = 0 then 'outbound' else 'inbound' end,
  'bounded timeout fixture',
  now() - make_interval(days => message_number)
from properties property
cross join generate_series(1,4) message_number
where property.address like 'Timeout fixture %';
analyze properties;
analyze messages;
SQL

OLD_URGENCY_OUTPUT="$LEADS_TMP/old-urgency.out"
if psql -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal \
  -c "set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'; set statement_timeout='2s'; select * from get_leads_board_urgency_counts(null,false,array[]::text[],'all',null,false,false,null,'2026-08-15 05:00Z','2026-08-16 05:00Z');" \
  >"$OLD_URGENCY_OUTPUT" 2>&1; then
  echo "pre-fix urgency query unexpectedly stayed below the bounded timeout" >&2
  exit 1
fi
grep -Eq 'ERROR:  +57014: canceling statement due to statement timeout' "$OLD_URGENCY_OUTPUT"

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal -f "$LEADS_URGENCY_TIMEOUT_MIGRATION" >/dev/null
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal -f "$LEADS_URGENCY_TIMEOUT_MIGRATION" >/dev/null

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal \
  -c "set role authenticated; set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111'; set statement_timeout='2s'; select * from get_leads_board_urgency_counts(null,false,array[]::text[],'all',null,false,false,null,'2026-08-15 05:00Z','2026-08-16 05:00Z');" \
  >/dev/null

psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL' >/dev/null
delete from messages where property_id in (
  select id from properties where address like 'Timeout fixture %'
);
delete from properties where address like 'Timeout fixture %';
SQL

NEW_FILTER_MATRIX="$LEADS_TMP/new-filter-matrix.out"
capture_filter_matrix "$NEW_FILTER_MATRIX"
cmp "$OLD_FILTER_MATRIX" "$NEW_FILTER_MATRIX"

# The forward function must preserve every optional filter while avoiding the
# full leads_board projection. These assertions execute the installed catalog
# function as an authenticated tenant, not migration text.
psql -v ON_ERROR_STOP=1 -h "$LEADS_SOCKET" -p "$LEADS_PORT" -U postgres -d sandra_leads_rehearsal <<'SQL'
set role authenticated;
set request.jwt.claim.sub='11111111-1111-4111-8111-111111111111';
do $$
declare
  function_source text;
begin
  select prosrc into function_source
  from pg_proc
  where oid = 'public.get_leads_board_urgency_counts(uuid,boolean,text[],text,text,boolean,boolean,boolean,timestamptz,timestamptz)'::regprocedure;
  if function_source like '%public.leads_board%'
  then raise exception 'urgency counts still expand the full leads_board projection'; end if;
  if function_source not like '%from public.properties property%'
  then raise exception 'urgency counts no longer use the bounded property read model'; end if;

  if exists (
    select 1
    from urgency_filter_cases c
    cross join lateral get_leads_board_urgency_counts(
      c.assignee_id,c.unassigned,c.search_tokens,c.motivation,null,c.hot_only,
      c.no_active_sequence,c.skip_traced,
      '2026-08-15 05:00Z','2026-08-16 05:00Z'
    ) r
    where (r.all_count,r.overdue_count,r.today_count,r.scheduled_count,r.no_action_count)
      is distinct from
      (c.expected_all,c.expected_overdue,c.expected_today,c.expected_scheduled,c.expected_none)
  ) then raise exception 'optional-filter result matrix changed'; end if;

  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array['today']::text[], 'all', null, false, false, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=1 and today_count=1
  ) then raise exception 'search or today urgency semantics changed'; end if;

  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array[]::text[], 'all', 'stale', false, false, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=1 and today_count=1
  ) then raise exception 'stale attention semantics changed'; end if;

  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array[]::text[], 'all', 'sequence_ended', false, false, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=1 and overdue_count=1
  ) then raise exception 'sequence-ended attention semantics changed'; end if;

  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array[]::text[], 'all', null, false, true, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=5 and no_action_count=3
  ) then raise exception 'active-sequence exclusion semantics changed'; end if;

  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array[]::text[], 'all', null, false, null, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=5 and no_action_count=3
  ) then raise exception 'nullable active-sequence semantics changed'; end if;

  if not exists (
    select 1 from get_leads_board_urgency_counts(
      null, false, array[]::text[], 'all', null, false, false, null,
      '2026-08-15 05:00Z', '2026-08-16 05:00Z'
    ) where all_count=6 and no_action_count=4
  ) then raise exception 'false active-sequence semantics changed'; end if;
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
 ('11111111-1111-4111-8111-111111111114','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',now()-interval '1 minute'),
 ('11111111-1111-4111-8111-111111111115','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',null),
 ('11111111-1111-4111-8111-111111111116','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','active',null),
 ('11111111-1111-4111-8111-111111111116','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','active',null);
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
  update properties set assigned_user_id='11111111-1111-4111-8111-111111111115'
  where id='aaaaaaaa-1000-4000-8000-000000000002';
  begin
    update properties set org_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where id='aaaaaaaa-1000-4000-8000-000000000002';
    raise exception 'org transfer unexpectedly preserved an invalid assignee';
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
  if (select total_count from stable_first) <> 4
    or jsonb_array_length((select rows from stable_first)) <> 2
    or jsonb_array_length((select rows from stable_second)) <> 2
    or (select total_count from stable_second) <> 4
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
