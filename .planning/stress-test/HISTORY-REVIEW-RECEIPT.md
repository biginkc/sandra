# Canonical history SQL validation — 2026-09-13

Target: owned local Postgres TCP 127.0.0.1:58322 only. Source database postgres was read using pg_dump --schema-only --no-owner. No campaign rows copied. All schema restore, pending migration and fixture writes targeted disposable lead_history_20260913_1701. No hosted connection or runtime restart.

Commands (PGPASSWORD supplied privately using existing owned-local convention):

1. pg_dump -h 127.0.0.1 -p 58322 -U postgres -d postgres -w --schema-only --no-owner -f /tmp/sandra-history-schema.sql
2. createdb -h 127.0.0.1 -p 58322 -U postgres -w lead_history_20260913_1701
3. psql -h 127.0.0.1 -p 58322 -U supabase_admin -d lead_history_20260913_1701 -w -v ON_ERROR_STOP=1 -f /tmp/sandra-history-schema.sql
4. psql -h 127.0.0.1 -p 58322 -U supabase_admin -d lead_history_20260913_1701 -w -v ON_ERROR_STOP=1 -f supabase/migrations/20260913230000_lead_acquisition_history.sql
5. LEAD_HISTORY_TEST_DB_URL=<owned-local-supabase_admin-url-with-disposable-database> npx vitest run src/lib/leads/acquisition-history.sql.test.ts
6. dropdb -h 127.0.0.1 -p 58322 -U postgres -w lead_history_20260913_1701

Restore needed supabase_admin because existing schema functions set restricted log_min_messages; first partial restore was dropped and recreated, only disposable DB affected. Test fixes: owner prerequisite and required property state; added port guard and authenticated role execution.

Result: 3/3 tests passed, actual RPC role authenticated. Same-org success, foreign/anonymous/expired access denied; grants no anon/service_role/direct table read; invalid limit/cursors denied; tied microsecond paging with no duplicates, original actor/time and exact cents retained.

Cleanup: fixture transactions left properties/auth.users/attempts/offers counts 0/0/0/0. Disposable database absent after drop; campaign history function absent, confirming pending migration not applied there. See /tmp/sandra-history-sql.log and /tmp/sandra-history-cleanup.log.

Independent review approved after resolving duplicate JSX key and linked Sandra dedup loss. Linked physical calls retain original acquisition rep outcome, note, actor and timestamp in the existing call card; normalization and component regressions cover this behavior. Review approval relayed by root on 2026-09-13.

Prior focused checks: 19 unit and 7 component tests passed. SQL suite executed separately with its opt-in local guarded URL; default full verification skips those opt-in tests. Full verification uses explicit LOCAL_REHEARSAL_DATABASE_URL on owned 127.0.0.1:58322; rehearsal creates and removes its own databases.

Full `npm run verify` completed successfully (2026-09-13): eSign atomic packet checks and isolated eSign Essentials SQL rehearsal passed; TypeScript passed; 355 unit files passed with 4,026 tests passed and the 3 opt-in SQL tests skipped; all 125 component files passed with 1,327 tests. The 3 history SQL tests passed separately as documented above. Log: /tmp/sandra-history-full-verify.log. No campaign migration apply, browser run, runtime restart, or integration performed by this worktree.
