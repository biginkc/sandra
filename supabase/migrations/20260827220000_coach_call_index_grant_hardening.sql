-- The coach ownership schema was originally installed through Supabase's
-- managed migration API. Supabase's default privileges granted every API role
-- all table privileges even though the table's RLS policies prevented writes.
-- Keep authorization layered: browsers may read only their own row, while the
-- server's service-role client retains the INSERT/UPDATE privileges required by
-- its idempotent upsert at call start.

begin;

revoke all on table public.coach_call_index from public, anon, authenticated;
grant select on table public.coach_call_index to authenticated;

-- Deliberately do not revoke service_role. Sandra's server-side call-start path
-- upserts the ownership row with that role; the browser never receives it.

commit;
