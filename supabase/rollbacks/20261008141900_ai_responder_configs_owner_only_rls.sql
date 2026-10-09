-- Rollback for 20261008141900_ai_responder_configs_owner_only_rls.
-- Restores the exact prior definition of every function/trigger/view/policy this
-- migration created, replaced or dropped (taken verbatim from the earlier migration
-- that last defined it), and removes everything it newly created. Idempotent.
begin;

-- Policies
drop policy if exists ai_responder_configs_owner_insert on public.ai_responder_configs;
drop policy if exists ai_responder_configs_owner_update on public.ai_responder_configs;
drop policy if exists ai_responder_configs_owner_delete on public.ai_responder_configs;
-- policy ai_responder_configs_org_insert on ai_responder_configs: restore prior definition
drop policy if exists ai_responder_configs_org_insert on public.ai_responder_configs;
create policy ai_responder_configs_org_insert on public.ai_responder_configs for insert to authenticated with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
-- policy ai_responder_configs_org_update on ai_responder_configs: restore prior definition
drop policy if exists ai_responder_configs_org_update on public.ai_responder_configs;
create policy ai_responder_configs_org_update on public.ai_responder_configs for update to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid())) with check (org_id in (select org_id from public.memberships where user_id = auth.uid()));
-- policy ai_responder_configs_org_delete on ai_responder_configs: restore prior definition
drop policy if exists ai_responder_configs_org_delete on public.ai_responder_configs;
create policy ai_responder_configs_org_delete on public.ai_responder_configs for delete to authenticated using (org_id in (select org_id from public.memberships where user_id = auth.uid()));

commit;
