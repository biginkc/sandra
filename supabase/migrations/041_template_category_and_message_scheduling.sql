-- Migration 041: Template pool reference on sequence steps + scheduled delivery for messages
--
-- Part 1: sequence_steps.template_category allows a step to reference a
-- named pool of SMS templates (sms_templates.category) instead of a single
-- template. The sequence-tick runner picks a deterministic variant per
-- enrollment using a SHA-256 seed. The existing XOR constraint is extended
-- to cover all three mutually-exclusive body sources.
--
-- Part 2: messages.scheduled_for enables bulk-queued messages to be paced
-- (e.g., 18 s apart) and released by the sequence-tick cron only when their
-- scheduled time arrives.

-- ============================================================================
-- Part 1: template_category on sequence_steps
-- ============================================================================

alter table public.sequence_steps
  add column if not exists template_category text;

-- Extend the XOR constraint (originally migration 035) to include
-- template_category as a third mutually-exclusive body source.
-- For send_sms steps, exactly one of (template_id, template_body,
-- template_category) must be populated and non-empty.
alter table public.sequence_steps
  drop constraint if exists sequence_steps_send_sms_body_xor;

alter table public.sequence_steps
  add constraint sequence_steps_send_sms_body_xor
  check (
    action_type <> 'send_sms'
    or (
      (  template_id       is not null
         and template_body     is null
         and template_category is null)
      or (template_id       is null
          and template_body is not null
          and length(trim(template_body)) > 0
          and template_category is null)
      or (template_id       is null
          and template_body     is null
          and template_category is not null
          and length(trim(template_category)) > 0)
    )
  );

-- ============================================================================
-- Part 2: scheduled_for on messages
-- ============================================================================

alter table public.messages
  add column if not exists scheduled_for timestamptz;

-- Cron drain query: messages WHERE status='queued' AND scheduled_for <= now().
-- Partial index over queued+scheduled rows only — won't grow after messages send.
create index if not exists idx_messages_queued_scheduled
  on public.messages (scheduled_for)
  where status = 'queued' and scheduled_for is not null;
