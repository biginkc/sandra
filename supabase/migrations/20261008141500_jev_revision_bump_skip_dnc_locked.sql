-- Fable review of 9cd4ec2b (fable-final-review-9cd4ec2b.json, jev-root-
-- round15-fable-fixes.md), finding 1 — P1 data loss:
--
-- trg_messages_bump_decision_context_revision (and the analogous tasks/
-- appointment trigger) run an unconditional
-- `update properties set decision_context_revision = decision_context_revision + 1`
-- as a side effect of inserting a message/task. On a DNC-locked property
-- (is_dnc_locked = true), that UPDATE is itself rejected by
-- properties_true_dnc_lock_guard ("permanently locked properties are
-- read-only", 20260815190000_true_dnc_property_lock.sql), which aborts
-- the ENTIRE transaction — including the message/task insert that
-- triggered it. A repeat inbound SMS (even a repeat STOP) from a
-- DNC-locked property's contact would 500 the webhook and never be
-- stored. 20260815190000 deliberately kept inbound ingestion intact
-- (its own comment: "webhook ingestion remains intact") — this
-- regressed that.
--
-- Fixed, explicit choice: a DNC-locked property's decision context never
-- needs staleness tracking again — no automatic Jev decision will ever
-- be applied to it (fn_auto_apply_jev_lead_decision's nurture branch
-- already short-circuits to `already_terminal` before any properties
-- write is attempted, since outreach_dispo is always 'dnc' on a locked
-- row; the new_lead branch checks is_dnc_locked directly). So: SKIP the
-- revision bump entirely for a locked property, rather than trying to
-- force it through (there is no safe way to bump a column the lock
-- guard treats as read-only without special-casing the guard itself,
-- which would weaken the lock broadly — exactly what root said not to
-- do). Message/task storage is preserved for locked properties either
-- way; only the moot revision counter is skipped. Scoped narrowly to
-- these two side-effect triggers — the property's OWN before-update
-- trigger (trg_properties_bump_decision_context_revision) is untouched:
-- a direct attempt to change a locked property's own tracked columns
-- should keep being rejected by the lock guard, same as today.

create or replace function public.jev_bump_decision_context_revision_on_message_activity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.channel = 'sms' and new.property_id is not null and new.direction in ('inbound', 'outbound') then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.property_id
      and is_dnc_locked = false;
  end if;
  return new;
end;
$$;

create or replace function public.jev_bump_decision_context_revision_on_appointment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.type = 'appointment' and new.related_property_id is not null then
    update public.properties
    set decision_context_revision = decision_context_revision + 1
    where id = new.related_property_id
      and is_dnc_locked = false;
  end if;
  return new;
end;
$$;
