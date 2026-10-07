-- 20261008143400_messages_v2_dead_letter.sql
-- Messages v2 fix round 4 (Opus round 4 + Astra round 3). Patches forward from
-- 20261008143300; earlier migrations are not edited.
--
-- 1. ai_reply_dead_letters: durable last resort for an AI reply that could not
--    be sent or stored after the bounded re-dispatches. Select owner||
--    acquisitions; insert service_role only.
-- 2. fn_renew_ai_send: verify-and-extend the send lease right before the
--    provider call (holder must match and the lease must not have expired).
-- 3. Accurate policy comments. hugo_has_active_org_access(org_id) is still
--    evaluated per row; only the readable-org subquery
--    (org_id in (select pipeline_runs_readable_org_ids())) is uncorrelated and
--    runs once per statement.
-- 4. Fail-loud RPC guard assertion, re-done as a REGEX that matches an actual
--    call (pipeline_runs_can_read followed by an open paren) after stripping
--    SQL comments, so a mention in a comment no longer satisfies it.
-- 5. reset_tenant_tables truncates ai_reply_dead_letters.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. ai_reply_dead_letters
-- ---------------------------------------------------------------------------
create table if not exists public.ai_reply_dead_letters (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid references public.pipeline_runs(id) on delete set null,
  conversation_id uuid,
  property_id uuid references public.properties(id) on delete cascade,
  inbound_message_id uuid references public.messages(id) on delete cascade,
  body text not null,
  reason text not null,
  created_at timestamptz not null default now()
);
comment on table public.ai_reply_dead_letters is
  'AI replies that could not be sent or stored after bounded re-dispatch. Never auto-sent; a human decides. Insert: service role only.';
create index if not exists idx_ai_reply_dead_letters_org_created
  on public.ai_reply_dead_letters (org_id, created_at desc);
create index if not exists idx_ai_reply_dead_letters_inbound
  on public.ai_reply_dead_letters (inbound_message_id);

alter table public.ai_reply_dead_letters enable row level security;
drop policy if exists ai_reply_dead_letters_org_select on public.ai_reply_dead_letters;
create policy ai_reply_dead_letters_org_select on public.ai_reply_dead_letters
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );

revoke all on table public.ai_reply_dead_letters
  from public, anon, authenticated, service_role;
grant select on table public.ai_reply_dead_letters to authenticated;
grant select, insert on table public.ai_reply_dead_letters to service_role;

-- ---------------------------------------------------------------------------
-- 2. fn_renew_ai_send
-- ---------------------------------------------------------------------------
create or replace function public.fn_renew_ai_send(
  p_conversation_id uuid,
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

  update public.ai_send_reservations
  set expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
  where conversation_id = p_conversation_id
    and holder = p_holder
    and expires_at > clock_timestamp();

  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke all on function public.fn_renew_ai_send(uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.fn_renew_ai_send(uuid, text, integer) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Policy comments
-- ---------------------------------------------------------------------------
comment on policy pipeline_runs_org_select on public.pipeline_runs is
  'owner || acquisitions. hugo_has_active_org_access(org_id) is still evaluated per row; only the readable-org subquery is once-per-statement.';
comment on policy pipeline_run_steps_org_select on public.pipeline_run_steps is
  'owner || acquisitions. hugo_has_active_org_access(org_id) is still evaluated per row; only the readable-org subquery is once-per-statement.';
comment on policy jev_lead_decisions_org_select on public.jev_lead_decisions is
  'owner || acquisitions. hugo_has_active_org_access(org_id) is still evaluated per row; only the readable-org subquery is once-per-statement.';
comment on policy ai_reply_drafts_org_select on public.ai_reply_drafts is
  'owner || acquisitions. hugo_has_active_org_access(org_id) is still evaluated per row; only the readable-org subquery is once-per-statement.';
comment on policy ai_reply_dead_letters_org_select on public.ai_reply_dead_letters is
  'owner || acquisitions. hugo_has_active_org_access(org_id) is still evaluated per row; only the readable-org subquery is once-per-statement.';

-- ---------------------------------------------------------------------------
-- 4. Fail-loud RPC guard assertion (regex on comment-stripped source)
-- ---------------------------------------------------------------------------
do $$
declare
  v_sig text;
  v_oid oid;
  v_src text;
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
    -- Strip "-- ..." comments (to end of line) before matching a real call.
    v_src := regexp_replace(pg_get_functiondef(v_oid), '--[^\n]*', '', 'g');
    if v_src !~ 'pipeline_runs_can_read\s*\(' then
      raise exception 'decision RPC % is missing a pipeline_runs_can_read( call', v_sig;
    end if;
  end loop;
  -- A superseded function must not linger with the old any-member check.
  for v_sig in
    select p.oid::regprocedure::text
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('fn_begin_jev_lead_decision_correction', 'fn_record_jev_lead_decision_correction')
      and regexp_replace(pg_get_functiondef(p.oid), '--[^\n]*', '', 'g') !~ 'pipeline_runs_can_read\s*\('
  loop
    raise exception 'decision RPC % is callable without a pipeline_runs_can_read( call', v_sig;
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
  v_new := replace(v_def, E'    public.ai_send_reservations,', E'    public.ai_send_reservations,\n    public.ai_reply_dead_letters,');
  if v_new = v_def then raise exception 'reset_tenant_tables dead-letter patch not applied'; end if;
  execute v_new;
end $$;

commit;
