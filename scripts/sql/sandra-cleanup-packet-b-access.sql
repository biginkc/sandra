-- Sandra production cleanup packet B: remove access for four exact QA users.
--
-- This is intentionally a separate approval packet. It deletes only
-- public.memberships rows. Auth identities, Hugo grants/operations, and all
-- business/provider/compliance history remain untouched.
--
-- Execute only through run-sandra-cleanup-packet.mjs. Packet B keeps its own
-- separate Fable approval and commit arm.

begin isolation level repeatable read;
set local role postgres;
set local search_path = public, extensions, pg_catalog;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local idle_in_transaction_session_timeout = '60s';

lock table public.memberships in share row exclusive mode;

create temp table packet_b_memberships on commit drop as
select m.*
from public.memberships m
join auth.users u on u.id = m.user_id
where lower(u.email) = any(array[
  'browser-v1-owner@bmhgroupkc.com',
  'jarrad+hugo-sops-20260729@bmhgroupkc.com',
  'jarrad+hugo-v1-smoke-20260729@bmhgroupkc.com',
  'sandra-filter-test@bmhgroupkc.com'
]::text[]);

do $$
declare
  v_count bigint;
  v_hash text;
begin
  select count(*), encode(digest(coalesce(string_agg(to_jsonb(m)::text, E'\n' order by org_id, user_id), ''), 'sha256'), 'hex')
  into v_count, v_hash
  from public.memberships m;
  if v_count <> 9 or v_hash <> '2685f7bf1a4b27077ced69006454df9d5f005b663c10ae7adc3ddaff9e92d3fd' then
    raise exception 'Sandra production identity fingerprint drift: count %, hash %', v_count, v_hash;
  end if;

  select
    count(*),
    encode(
      digest(
        coalesce(
          string_agg(to_jsonb(m)::text, E'\n' order by org_id, user_id),
          ''
        ),
        'sha256'
      ),
      'hex'
    )
  into v_count, v_hash
  from packet_b_memberships m;

  if v_count <> 4
     or v_hash <> '4a0d6f2698defab726950fc6cc0fd5f9eed4e76fda236779fb48639a32819ded'
  then
    raise exception 'Packet B membership manifest drift: count %, hash %',
      v_count, v_hash;
  end if;

  if exists (
    select 1
    from packet_b_memberships
    where org_id <> '00000000-0000-0000-0000-000000000bbb'::uuid
  ) then
    raise exception 'Packet B organization scope drifted';
  end if;

  if (select count(*) from packet_b_memberships where access_status='active') <> 2
     or (select count(*) from packet_b_memberships where access_status='suspended') <> 2
     or exists (
       select 1
       from packet_b_memberships
       where access_status not in ('active', 'suspended')
     )
  then
    raise exception 'Packet B access lifecycle drifted';
  end if;

  if exists (
    select 1 from public.properties p
    join packet_b_memberships q on q.user_id=p.assigned_user_id
    where p.deleted_at is null
  ) or exists (
    select 1 from public.tasks t
    join packet_b_memberships q on q.user_id=t.assignee_id
  ) then
    raise exception 'A QA membership still owns a retained property or task';
  end if;

  -- The membership table is currently a leaf. If a future migration makes
  -- another table depend on a membership row, require a new export/review.
  if exists (
    select 1
    from pg_constraint c
    join pg_class parent on parent.oid=c.confrelid
    join pg_namespace parent_ns on parent_ns.oid=parent.relnamespace
    where c.contype='f'
      and parent_ns.nspname='public'
      and parent.relname='memberships'
  ) then
    raise exception 'Packet B membership dependency shape changed';
  end if;
end $$;

create temp table packet_b_results (
  operation text primary key,
  affected_rows bigint not null
) on commit drop;

with deleted as (
  delete from public.memberships m
  using packet_b_memberships q
  where m.org_id=q.org_id and m.user_id=q.user_id
  returning 1
)
insert into packet_b_results
select 'qa_memberships_deleted', count(*) from deleted;

do $$
begin
  if (select affected_rows from packet_b_results where operation='qa_memberships_deleted') <> 4 then
    raise exception 'Packet B affected-row mismatch';
  end if;

  if (select count(*) from public.memberships where access_status='active') <> 5 then
    raise exception 'Packet B remaining active roster count drifted';
  end if;
end $$;

select jsonb_build_object(
  'mode', 'ROLLBACK_REHEARSAL',
  'project_ref', 'copflsklaefwzipsrjqz',
  'result', (
    select jsonb_object_agg(operation, affected_rows order by operation)
    from packet_b_results
  )
) as packet_b_rehearsal;

rollback;
