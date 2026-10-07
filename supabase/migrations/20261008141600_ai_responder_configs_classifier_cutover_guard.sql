-- Fable review of 9cd4ec2b (fable-final-review-9cd4ec2b.json, jev-root-
-- round15-fable-fixes.md), finding 2 — P1 cutover policy bypass:
--
-- fn_update_jev_automatic_classification (round 14) enforces active-
-- owner authorization, but that RPC is not the only write path.
-- 054_memberships_and_rls_rewrite.sql's ai_responder_configs_org_update
-- RLS policy still permits ANY membership row (no role/active/expiry
-- check) to UPDATE the whole table directly, and `authenticated` still
-- holds table-level UPDATE on every column, including
-- classifier_provider/classifier_mode. Any active org member — not just
-- an owner — could bypass the RPC entirely with a direct PostgREST PATCH
-- and flip the org's Jev cutover.
--
-- Fixed narrowly: a BEFORE UPDATE trigger on ai_responder_configs that
-- only inspects classifier_provider/classifier_mode specifically — if
-- either is actually changing, the caller must be an active,
-- non-expired, non-deletion-prepared OWNER of the row's org (the exact
-- condition fn_update_jev_automatic_classification already enforces).
-- Every OTHER column (active, system_prompt, max_turns, min_confidence,
-- business_hours_only, reply_delay_*) is untouched — updateAiResponderConfig
-- (the separate, pre-existing settings action) keeps working exactly as
-- before for any org member the app's isAdminEmail check already gates.
-- This does not rewrite the RLS policy (which would need to distinguish
-- "which columns changed" that RLS itself cannot express) or the
-- already-applied owner-only RPC migrations — it is a genuinely new,
-- additive guard.

create or replace function public.ai_responder_configs_classifier_cutover_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.classifier_provider is distinct from old.classifier_provider
     or new.classifier_mode is distinct from old.classifier_mode
  then
    if coalesce(auth.role(), '') = 'service_role' then
      return new;
    end if;
    if not exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = new.org_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    ) then
      raise exception 'FORBIDDEN: only an active org owner may change Jev automatic classification'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_ai_responder_configs_classifier_cutover_guard on public.ai_responder_configs;
create trigger trg_ai_responder_configs_classifier_cutover_guard
  before update on public.ai_responder_configs
  for each row execute function public.ai_responder_configs_classifier_cutover_guard();
