-- ============================================================================
-- Reset helper for integration tests.
--
-- CAUTION: This function truncates every tenant-data table and is
-- intentionally destructive. It exists so integration tests can reset
-- state between runs without dragging in a pg driver. Execution is
-- revoked from `public` and `authenticated`, so only the `service_role`
-- key can call it. Never invoke from application code.
--
-- Ships to every environment (dev + test + eventual prod) for schema
-- parity. In prod the function is inert unless someone with the service
-- role key calls it — same blast radius as any other service_role op.
-- ============================================================================

create or replace function reset_tenant_tables()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  truncate table
    job_items,
    messages,
    property_merges,
    jobs,
    csv_imports,
    webhook_events,
    properties,
    homeowner_details,
    agent_details,
    contacts,
    cass_cache
  restart identity cascade;
end;
$$;

revoke execute on function reset_tenant_tables() from public;
revoke execute on function reset_tenant_tables() from authenticated;
-- service_role retains execute permission by default.
