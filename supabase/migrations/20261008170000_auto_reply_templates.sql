-- 20261008170000_auto_reply_templates.sql
-- Messages v2 Phase 4 (PLAN D5 / section 4.6 / Q7). Only a template a human
-- has approved in the Templates UI may ever be sent automatically. This
-- migration adds:
--   1. sms_templates.approved_for_auto_send / approved_by / approved_at /
--      approved_content (the exact text the human saw and approved). Default
--      false; nothing is approved by this migration. The approval columns can
--      only be written by fn_set_template_auto_send_approval (trigger-enforced)
--      and any edit to the text, or deleting the template, revokes approval.
--   2. sms_template_approval_events: append-only record of every approval and
--      revocation, including the exact text.
--   3. auto_reply_templates: outcome (+ optional reply_intent) -> template
--      mapping, written only by fn_set_auto_reply_template (owner-only RPC).
--      Read: owner or Acquisitions (same audience as Messages v2). The
--      responder reads it with the service role.
--   4. a partial index on ai_response_claims for the stale-claim sweeper that
--      flags a template that was sent but whose outcome never applied.
-- No template text, mapping or approval is seeded.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Approval columns on sms_templates
-- ---------------------------------------------------------------------------
alter table public.sms_templates
  add column if not exists approved_for_auto_send boolean not null default false,
  add column if not exists approved_by uuid references auth.users(id) on delete set null,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_content text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'sms_templates_approval_shape_check'
  ) then
    alter table public.sms_templates
      add constraint sms_templates_approval_shape_check
      check (
        (approved_for_auto_send = false)
        or (approved_at is not null and approved_content is not null)
      );
  end if;
end $$;

comment on column public.sms_templates.approved_for_auto_send is
  'True only after an org owner approved this exact text for automatic replies in the Templates UI (fn_set_template_auto_send_approval). Revoked automatically when the text changes or the template is deleted.';
comment on column public.sms_templates.approved_content is
  'The exact text the approver was shown. The responder sends a template only while content = approved_content.';

-- ---------------------------------------------------------------------------
-- 2. Approval audit (append-only)
-- ---------------------------------------------------------------------------
create table if not exists public.sms_template_approval_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  template_id uuid not null references public.sms_templates(id) on delete cascade,
  action text not null,
  content text not null,
  actor uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint sms_template_approval_events_action_check
    check (action in ('approved', 'revoked', 'revoked_text_changed', 'revoked_deleted'))
);
create index if not exists idx_sms_template_approval_events_template
  on public.sms_template_approval_events (template_id, created_at desc);

alter table public.sms_template_approval_events enable row level security;
drop policy if exists sms_template_approval_events_owner_select on public.sms_template_approval_events;
create policy sms_template_approval_events_owner_select on public.sms_template_approval_events
  for select to authenticated
  using (
    exists (
      select 1 from public.memberships m
      where m.user_id = (select auth.uid())
        and m.org_id = sms_template_approval_events.org_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    )
  );
revoke all on table public.sms_template_approval_events
  from public, anon, authenticated, service_role;
grant select on table public.sms_template_approval_events to authenticated;
grant select on table public.sms_template_approval_events to service_role;

-- The trigger below writes revocation events; it runs as the table owner.
create or replace function public.sms_templates_guard_approval()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rpc boolean := coalesce(current_setting('sandra.template_approval', true), '') = 'on';
  v_action text;
begin
  if tg_op = 'INSERT' then
    if not v_rpc and (new.approved_for_auto_send or new.approved_by is not null
                      or new.approved_at is not null or new.approved_content is not null) then
      raise exception 'APPROVAL_RPC_ONLY' using errcode = '42501';
    end if;
    return new;
  end if;

  if not v_rpc and (
       new.approved_for_auto_send is distinct from old.approved_for_auto_send
    or new.approved_by is distinct from old.approved_by
    or new.approved_at is distinct from old.approved_at
    or new.approved_content is distinct from old.approved_content
  ) then
    raise exception 'APPROVAL_RPC_ONLY' using errcode = '42501';
  end if;

  -- Approval belongs to one exact text: editing it or deleting the template
  -- revokes it (the human must approve the new text).
  if not v_rpc and old.approved_for_auto_send then
    if new.deleted_at is not null and old.deleted_at is null then
      v_action := 'revoked_deleted';
    elsif new.content is distinct from old.content then
      v_action := 'revoked_text_changed';
    end if;
    if v_action is not null then
      new.approved_for_auto_send := false;
      new.approved_by := null;
      new.approved_at := null;
      new.approved_content := null;
      insert into public.sms_template_approval_events (org_id, template_id, action, content, actor)
      values (old.org_id, old.id, v_action, old.approved_content, auth.uid());
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.sms_templates_guard_approval() from public, anon, authenticated, service_role;

drop trigger if exists trg_sms_templates_guard_approval on public.sms_templates;
create trigger trg_sms_templates_guard_approval
  before insert or update on public.sms_templates
  for each row execute function public.sms_templates_guard_approval();

-- ---------------------------------------------------------------------------
-- 3. outcome -> template mapping
-- ---------------------------------------------------------------------------
create table if not exists public.auto_reply_templates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  outcome text not null,
  reply_intent text,
  template_id uuid not null references public.sms_templates(id) on delete cascade,
  priority integer not null default 100,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auto_reply_templates_outcome_check
    check (outcome in ('nurture', 'not_interested')),
  constraint auto_reply_templates_reply_intent_check
    check (reply_intent is null or reply_intent in ('positive', 'negative', 'neutral')),
  constraint auto_reply_templates_priority_check
    check (priority between 0 and 10000)
);
-- Re-assert the outcome allow-list on a database that already has an earlier
-- draft of this table (PLAN D5: new_lead never auto-replies). Nothing is
-- seeded, so any new_lead mapping is a stray from that draft and is dropped.
delete from public.auto_reply_templates where outcome not in ('nurture', 'not_interested');
alter table public.auto_reply_templates drop constraint if exists auto_reply_templates_outcome_check;
alter table public.auto_reply_templates
  add constraint auto_reply_templates_outcome_check
  check (outcome in ('nurture', 'not_interested'));
create unique index if not exists uq_auto_reply_templates_key
  on public.auto_reply_templates (org_id, outcome, coalesce(reply_intent, ''), template_id);
create index if not exists idx_auto_reply_templates_lookup
  on public.auto_reply_templates (org_id, outcome) where active;

comment on table public.auto_reply_templates is
  'Which approved template answers a Jev outcome (optionally narrowed by reply_intent). Writable only via fn_set_auto_reply_template (owner). A mapping to a template that is not approved is inert.';

alter table public.auto_reply_templates enable row level security;
drop policy if exists auto_reply_templates_org_select on public.auto_reply_templates;
create policy auto_reply_templates_org_select on public.auto_reply_templates
  for select to authenticated
  using (
    public.hugo_has_active_org_access(org_id)
    and org_id in (select public.pipeline_runs_readable_org_ids())
  );
revoke all on table public.auto_reply_templates
  from public, anon, authenticated, service_role;
grant select on table public.auto_reply_templates to authenticated;
grant select on table public.auto_reply_templates to service_role;

drop trigger if exists trg_auto_reply_templates_updated_at on public.auto_reply_templates;
create trigger trg_auto_reply_templates_updated_at
  before update on public.auto_reply_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. RPCs (owner-only; record who)
-- ---------------------------------------------------------------------------
create or replace function public.fn_set_template_auto_send_approval(
  p_template_id uuid,
  p_approved boolean,
  p_expected_content text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_tpl public.sms_templates%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_template_id is null or p_approved is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  select * into v_tpl from public.sms_templates where id = p_template_id for update;
  if not found then
    raise exception 'TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor
      and m.org_id = v_tpl.org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  perform set_config('sandra.template_approval', 'on', true);

  if p_approved then
    if v_tpl.deleted_at is not null then
      raise exception 'TEMPLATE_DELETED' using errcode = '22023';
    end if;
    -- The human approves the text they were shown, character for character.
    if p_expected_content is null or p_expected_content is distinct from v_tpl.content then
      raise exception 'CONTENT_CHANGED' using errcode = '40001';
    end if;
    update public.sms_templates
    set approved_for_auto_send = true,
        approved_by = v_actor,
        approved_at = v_now,
        approved_content = v_tpl.content
    where id = p_template_id;
    insert into public.sms_template_approval_events (org_id, template_id, action, content, actor)
    values (v_tpl.org_id, p_template_id, 'approved', v_tpl.content, v_actor);
    perform set_config('sandra.template_approval', 'off', true);
    return jsonb_build_object('ok', true, 'templateId', p_template_id, 'approved', true,
      'approvedBy', v_actor, 'approvedAt', v_now);
  end if;

  if v_tpl.approved_for_auto_send then
    update public.sms_templates
    set approved_for_auto_send = false,
        approved_by = null,
        approved_at = null,
        approved_content = null
    where id = p_template_id;
    insert into public.sms_template_approval_events (org_id, template_id, action, content, actor)
    values (v_tpl.org_id, p_template_id, 'revoked', v_tpl.approved_content, v_actor);
  end if;
  perform set_config('sandra.template_approval', 'off', true);
  return jsonb_build_object('ok', true, 'templateId', p_template_id, 'approved', false);
end;
$$;

revoke all on function public.fn_set_template_auto_send_approval(uuid, boolean, text)
  from public, anon, service_role;
grant execute on function public.fn_set_template_auto_send_approval(uuid, boolean, text)
  to authenticated;

create or replace function public.fn_set_auto_reply_template(
  p_org_id uuid,
  p_outcome text,
  p_reply_intent text,
  p_template_id uuid,
  p_priority integer default 100,
  p_active boolean default true,
  p_mapping_id uuid default null,
  p_delete boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
begin
  if v_actor is null then
    raise exception 'AUTHENTICATION_REQUIRED' using errcode = '42501';
  end if;
  if p_org_id is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor
      and m.org_id = p_org_id
      and m.role = 'owner'
      and m.access_status = 'active'
      and m.deletion_prepared_at is null
      and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
  ) then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;

  if p_delete then
    if p_mapping_id is null then
      raise exception 'INVALID_REQUEST' using errcode = '22023';
    end if;
    delete from public.auto_reply_templates
    where id = p_mapping_id and org_id = p_org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'MAPPING_NOT_FOUND' using errcode = 'P0002';
    end if;
    return jsonb_build_object('ok', true, 'mappingId', v_id, 'deleted', true);
  end if;

  if p_outcome is null or p_outcome not in ('nurture', 'not_interested') then
    raise exception 'INVALID_OUTCOME' using errcode = '22023';
  end if;
  if p_reply_intent is not null and p_reply_intent not in ('positive', 'negative', 'neutral') then
    raise exception 'INVALID_REPLY_INTENT' using errcode = '22023';
  end if;
  if p_priority is null or p_priority < 0 or p_priority > 10000 or p_active is null then
    raise exception 'INVALID_REQUEST' using errcode = '22023';
  end if;
  if p_template_id is null or not exists (
    select 1 from public.sms_templates t
    where t.id = p_template_id and t.org_id = p_org_id and t.deleted_at is null
  ) then
    raise exception 'TEMPLATE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_mapping_id is null then
    insert into public.auto_reply_templates (
      org_id, outcome, reply_intent, template_id, priority, active, created_by, updated_by
    ) values (
      p_org_id, p_outcome, p_reply_intent, p_template_id, p_priority, p_active, v_actor, v_actor
    )
    on conflict (org_id, outcome, coalesce(reply_intent, ''), template_id) do update
      set priority = excluded.priority,
          active = excluded.active,
          updated_by = v_actor
    returning id into v_id;
  else
    update public.auto_reply_templates
    set outcome = p_outcome,
        reply_intent = p_reply_intent,
        template_id = p_template_id,
        priority = p_priority,
        active = p_active,
        updated_by = v_actor
    where id = p_mapping_id and org_id = p_org_id
    returning id into v_id;
    if v_id is null then
      raise exception 'MAPPING_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;
  return jsonb_build_object('ok', true, 'mappingId', v_id, 'deleted', false);
end;
$$;

revoke all on function public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)
  from public, anon, service_role;
grant execute on function public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4b. Stale-claim sweeper index: the template step stamps a dispatch claim with
-- outcome = 'template_sent_outcome_pending' between the template send and the
-- outcome apply; the sweep looks for those past their lease.
-- ---------------------------------------------------------------------------
create index if not exists idx_ai_response_claims_template_pending
  on public.ai_response_claims (lease_expires_at)
  where outcome = 'template_sent_outcome_pending';

-- ---------------------------------------------------------------------------
-- 5. Test resets: clear mappings and approvals (system-managed templates
-- survive a reset, their approval must not).
-- ---------------------------------------------------------------------------
do $$
declare
  v_def text;
  v_new text;
  v_anchor constant text := E'  delete from public.sms_templates\n';
begin
  v_def := pg_get_functiondef('public.reset_tenant_tables()'::regprocedure);
  if position('auto_reply_templates' in v_def) > 0 then
    return;
  end if;
  v_new := replace(
    v_def,
    v_anchor,
    E'  perform set_config(''sandra.template_approval'', ''on'', true);\n'
    || E'  delete from public.auto_reply_templates;\n'
    || E'  delete from public.sms_template_approval_events;\n'
    || E'  update public.sms_templates set approved_for_auto_send = false, approved_by = null, approved_at = null, approved_content = null where approved_for_auto_send;\n'
    || E'  perform set_config(''sandra.template_approval'', ''off'', true);\n'
    || v_anchor
  );
  if v_new = v_def then raise exception 'reset_tenant_tables approval patch not applied'; end if;
  execute v_new;
end $$;

commit;
