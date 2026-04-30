-- Migration 035: Sequence steps can reference an SMS template
-- Adds nullable `template_id` FK so a step can either store its own
-- inline copy in `template_body` (the V1 path) or reference a row in
-- `sms_templates` (created in 034). The render path in tick.ts picks
-- the source: if `template_id` is set, fetch the template and use its
-- `content`; otherwise fall back to `template_body`.
--
-- on delete set null: deleting a template should not break enrollments
-- mid-flight. The next tick that hits a step with a deleted template
-- will see template_id = null + template_body = null and surface a
-- clear "step misconfigured" failure rather than corrupting the run.

alter table public.sequence_steps
  add column if not exists template_id uuid
    references public.sms_templates(id) on delete set null;

create index if not exists idx_sequence_steps_template_id
  on public.sequence_steps(template_id)
  where template_id is not null;

-- Schema-level XOR enforcement: for send_sms steps, exactly one of
-- (template_id, template_body) must be populated, and template_body
-- (when chosen) must be non-empty after trim. Without this constraint
-- a direct SQL fix or future code path could leave both populated
-- (silent-precedence rule in tick.ts) or both null (renders empty SMS,
-- the provider may accept and bill for it). Defense-in-depth in
-- tick.ts also rejects empty bodies — this constraint is the
-- authoritative integrity guarantee.
alter table public.sequence_steps
  drop constraint if exists sequence_steps_send_sms_body_xor;
alter table public.sequence_steps
  add constraint sequence_steps_send_sms_body_xor
  check (
    action_type <> 'send_sms'
    or (
      (template_id is not null and template_body is null)
      or (template_id is null and template_body is not null
          and length(trim(template_body)) > 0)
    )
  );
