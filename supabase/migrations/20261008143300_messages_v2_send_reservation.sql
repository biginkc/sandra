-- 20261008143300_messages_v2_send_reservation.sql
-- Messages v2 fix round 3 (Astra round 2). Patches forward from 20261008143200.
--
-- 1. ai_send_reservations + fn_reserve_ai_send / fn_release_ai_send: a
--    per-conversation send lease. The AI responder reserves the conversation,
--    re-validates "I am still the latest inbound and nothing was sent since my
--    claim" UNDER the lease, sends, then releases. Two concurrent sends for the
--    same conversation can no longer both pass the check. The lease expires
--    (a crashed worker cannot lock a conversation forever).
-- 2. ai_reply_drafts: at most one PENDING draft per inbound message, so the
--    draft write is idempotent and a retried dispatch cannot duplicate it.
-- 3. Access policies re-stated with an UNCORRELATED subquery
--    (org_id in (select pipeline_runs_readable_org_ids())). The earlier
--    "(select pipeline_runs_can_read(org_id))" form depends on each row's
--    org_id, so Postgres re-runs it per row; it is NOT cached per org.
-- 4. Fail-loud assertion that every user-callable decision RPC that exists
--    carries the pipeline_runs_can_read guard (the 20261008143200 patch loop
--    skipped missing functions silently).
-- 5. reset_tenant_tables truncates ai_send_reservations.
-- 6. ai_responder_configs.outbound_mode comment corrected (either hold wins).

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Send reservations
-- ---------------------------------------------------------------------------
create table if not exists public.ai_send_reservations (
  conversation_id uuid primary key,
  holder text not null,
  inbound_message_id uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
comment on table public.ai_send_reservations is
  'Per-conversation AI send lease. conversation_id holds the conversation id, or the contact id when the thread has no conversation. Service role only.';

alter table public.ai_send_reservations enable row level security;
revoke all on table public.ai_send_reservations
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.ai_send_reservations to service_role;

create or replace function public.fn_reserve_ai_send(
  p_conversation_id uuid,
  p_inbound_message_id uuid,
  p_holder text,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  if p_conversation_id is null or p_holder is null or length(p_holder) = 0
     or p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 3600 then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  insert into public.ai_send_reservations as r (
    conversation_id, holder, inbound_message_id, expires_at, created_at
  ) values (
    p_conversation_id, p_holder, p_inbound_message_id,
    clock_timestamp() + make_interval(secs => p_lease_seconds), clock_timestamp()
  )
  on conflict (conversation_id) do update
    set holder = excluded.holder,
        inbound_message_id = excluded.inbound_message_id,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    where r.expires_at <= clock_timestamp();

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

create or replace function public.fn_release_ai_send(
  p_conversation_id uuid,
  p_holder text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_rows integer;
begin
  delete from public.ai_send_reservations
  where conversation_id = p_conversation_id
    and holder = p_holder;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.fn_reserve_ai_send(uuid, uuid, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.fn_release_ai_send(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_reserve_ai_send(uuid, uuid, text, integer) to service_role;
grant execute on function public.fn_release_ai_send(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. One pending draft per inbound message
-- ---------------------------------------------------------------------------
-- Duplicates (possible before this index) keep the newest; older ones are
-- discarded, never deleted.
update public.ai_reply_drafts d
set status = 'discarded'
where d.status = 'pending'
  and d.inbound_message_id is not null
  and exists (
    select 1 from public.ai_reply_drafts n
    where n.inbound_message_id = d.inbound_message_id
      and n.status = 'pending'
      and (n.created_at, n.id) > (d.created_at, d.id)
  );
create unique index if not exists uq_ai_reply_drafts_pending_inbound
  on public.ai_reply_drafts (inbound_message_id)
  where status = 'pending' and inbound_message_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Access policies: uncorrelated, evaluated once per statement
-- ---------------------------------------------------------------------------
create or replace function public.pipeline_runs_readable_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.org_id
  from public.memberships m
  where m.user_id = (select auth.uid())
    and m.access_status = 'active'
    and m.deletion_prepared_at is null
    and (m.access_expires_at is null or m.access_expires_at > now())
    and (m.role = 'owner' or m.acquisitions_enabled = true);
$$;
revoke all on function public.pipeline_runs_readable_org_ids()
  from public, anon, authenticated, service_role;
grant execute on function public.pipeline_runs_readable_org_ids() to authenticated;

drop policy if exists pipeline_runs_org_select on public.pipeline_runs;
create policy pipeline_runs_org_select on public.pipeline_runs
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );
drop policy if exists pipeline_run_steps_org_select on public.pipeline_run_steps;
create policy pipeline_run_steps_org_select on public.pipeline_run_steps
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );
drop policy if exists jev_lead_decisions_org_select on public.jev_lead_decisions;
create policy jev_lead_decisions_org_select on public.jev_lead_decisions
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );
drop policy if exists ai_reply_drafts_org_select on public.ai_reply_drafts;
create policy ai_reply_drafts_org_select on public.ai_reply_drafts
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

-- ---------------------------------------------------------------------------
-- 4. Fail-loud RPC guard assertion
-- ---------------------------------------------------------------------------
-- These are the user-callable decision RPCs that exist after the
-- 20261008140000..20261008143200 chain. (fn_begin_/fn_record_jev_lead_decision_
-- correction were superseded by fn_apply_and_record_jev_lead_decision_correction
-- and no longer exist; fn_auto_apply_/fn_propose_ are service-role only.)
do $$
declare
  v_sig text;
  v_oid oid;
begin
  foreach v_sig in array array[
    'public.fn_confirm_jev_lead_decision(uuid)',
    'public.fn_correct_jev_lead_decision(uuid,text,text)',
    'public.fn_apply_and_record_jev_lead_decision_correction(uuid,text,text)',
    'public.fn_mark_jev_lead_decision_reviewed(uuid)'
  ]
  loop
    v_oid := to_regprocedure(v_sig);
    if v_oid is null then
      raise exception 'expected decision RPC % does not exist', v_sig;
    end if;
    if pg_get_functiondef(v_oid) not like '%pipeline_runs_can_read%' then
      raise exception 'decision RPC % is missing the pipeline_runs_can_read guard', v_sig;
    end if;
  end loop;
  -- A superseded function must not linger with the old any-member check.
  for v_sig in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fn_begin_jev_lead_decision_correction', 'fn_record_jev_lead_decision_correction')
      and pg_get_functiondef(p.oid) not like '%pipeline_runs_can_read%'
  loop
    raise exception 'decision RPC % is callable without the pipeline_runs_can_read guard', v_sig;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 5. reset_tenant_tables
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  v_new := replace(v_def, E'    public.ai_reply_drafts,', E'    public.ai_reply_drafts,\n    public.ai_send_reservations,');
  if v_new = v_def then raise exception 'reset_tenant_tables reservation patch not applied'; end if;
  execute v_new;
end $$;

comment on column public.ai_responder_configs.outbound_mode is
  'send (default, today''s behaviour) or hold (draft-only: AI replies are stored in ai_reply_drafts instead of sent). Either hold wins: a send needs this column = send AND env AI_RESPONDER_OUTBOUND_MODE unset or send; env send never overrides hold.';

commit;
