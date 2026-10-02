-- Backfill of the properties filter cache (see 20261002110000).
--
-- Why this shape: the Supabase CLI applies a file as a pipeline of statements,
-- so a DO block cannot COMMIT per batch. Instead the file contains 64 explicit
-- begin/commit pairs, one per hash bucket of property ids. Each transaction
-- locks and updates only ~1/64 of the properties (FOR NO KEY UPDATE, via
-- refresh_property_filter_cache), so no lock is held for the whole backfill.
-- Idempotent and safe to re-run: rows already correct are not rewritten, and
-- the triggers keep new writes correct while this runs.
-- Apply this right after 20261002110000 and BEFORE deploying the app code.

set lock_timeout = '5s';

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 0), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 1), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 2), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 3), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 4), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 5), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 6), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 7), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 8), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 9), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 10), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 11), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 12), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 13), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 14), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 15), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 16), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 17), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 18), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 19), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 20), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 21), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 22), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 23), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 24), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 25), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 26), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 27), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 28), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 29), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 30), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 31), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 32), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 33), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 34), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 35), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 36), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 37), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 38), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 39), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 40), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 41), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 42), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 43), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 44), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 45), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 46), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 47), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 48), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 49), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 50), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 51), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 52), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 53), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 54), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 55), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 56), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 57), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 58), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 59), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 60), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 61), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 62), '{}'::uuid[]));
commit;

begin;
select public.refresh_property_filter_cache(coalesce(array(select id from public.properties where (pg_catalog.hashtext(id::text) & 2147483647) % 64 = 63), '{}'::uuid[]));
commit;

notify pgrst, 'reload schema';
