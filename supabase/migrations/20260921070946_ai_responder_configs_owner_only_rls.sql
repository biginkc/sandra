-- Fable re-review of e5d001bb (fable-final-review-e5d001bb.json,
-- jev-root-round17-fable2-fixes.md), finding 1 — P1 cutover
-- authorization lifecycle bypass:
--
-- The round-15 trigger (20260921064444_ai_responder_configs_classifier_cutover_guard.sql)
-- only fires BEFORE UPDATE and only inspects classifier_provider/
-- classifier_mode. It closes exactly one path. 054_memberships_and_rls_rewrite.sql's
-- ai_responder_configs_org_insert / _org_update / _org_delete policies
-- still admit ANY membership row (no owner/active/expiry check), so an
-- ordinary active member could:
--   - PATCH active=false on the current active row (a non-classifier
--     column the trigger explicitly allows), freeing up the partial
--     unique index (one active row per org), then
--   - INSERT a brand-new row with active=true, classifier_provider='jev',
--     classifier_mode='automatic' — the trigger only guards UPDATE, not
--     INSERT — cutting the org over anyway, or
--   - DELETE the active row outright, then INSERT a replacement.
--
-- Fixed with a coherent RLS model instead of another narrow trigger:
-- INSERT/UPDATE/DELETE on ai_responder_configs now require the caller be
-- an active, non-expired, non-deletion-prepared OWNER of the row's
-- actual org — the SAME bar fn_update_jev_automatic_classification
-- already enforces for the one column pair, now applied to the WHOLE
-- table's write surface. UPDATE's WITH CHECK re-evaluates the SAME
-- condition against the (possibly new) org_id, so org_id cannot be
-- reassigned to an org the caller isn't an active owner of either.
-- SELECT is intentionally left as broad, active-membership visibility
-- (public.hugo_has_active_org_access) — read access to settings does
-- not need to be owner-only, only mutation does.
--
-- The round-15 trigger is left in place (redundant but harmless — an
-- owner passes both checks; it stays as defense in depth for the two
-- most sensitive columns specifically).

drop policy if exists ai_responder_configs_org_insert on public.ai_responder_configs;
drop policy if exists ai_responder_configs_org_update on public.ai_responder_configs;
drop policy if exists ai_responder_configs_org_delete on public.ai_responder_configs;

create policy ai_responder_configs_owner_insert on public.ai_responder_configs
  for insert to authenticated
  with check (
    exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = ai_responder_configs.org_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    )
  );

create policy ai_responder_configs_owner_update on public.ai_responder_configs
  for update to authenticated
  using (
    exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = ai_responder_configs.org_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    )
  )
  with check (
    exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = ai_responder_configs.org_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    )
  );

create policy ai_responder_configs_owner_delete on public.ai_responder_configs
  for delete to authenticated
  using (
    exists (
      select 1
      from public.memberships m
      where m.user_id = auth.uid()
        and m.org_id = ai_responder_configs.org_id
        and m.role = 'owner'
        and m.access_status = 'active'
        and m.deletion_prepared_at is null
        and (m.access_expires_at is null or m.access_expires_at > statement_timestamp())
    )
  );
