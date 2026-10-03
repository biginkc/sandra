# Emergency capture-off gap and recovery

This packet is a tooling-only emergency control for the three Inbox migrations
at `4ee23fcb`. It does not drop or disable a trigger. It replaces the 21
function bodies used by the 25 canonical source-table capture triggers with
no-ops, so the trigger objects stay attached. The two
`public.inbox_guard_inbound_revision` triggers are deliberately excluded: they
are integrity guards, not capture, and remain live to reject fabricated
server-owned revisions. The covered triggers are AFTER-row and return `NULL`.

The receipt table is created in `inbox_emergency`, which is intentionally
outside PR #725's `CATALOG_SCHEMAS` fingerprint list. The schema and table
revoke privileges from `PUBLIC`, `anon`, `authenticated`, and `service_role`.
That placement is required so the reviewed reconciliation completion/recovery
tool does not reject its own capture-off receipt as catalog drift.

## What the no-op window loses

Canonical writes continue to commit, but the Inbox-side capture state is not
advanced for those writes. Depending on the source table, the window can miss:

- `messages`: inbound heads/revisions, message dirty/version/route-edge rows,
  and operation target revisions.
- `properties`: parent work, policy versions, SMS-scope revisions, and reply
  context market revisions.
- `contacts`: parent work and policy versions.
- `memberships`: policy versions and access-epoch invalidation.
- `sequence_enrollments`: SMS-scope revisions.
- `message_threads`: safety routes, backfill collision work, and policy
  versions.
- `consent_events`: safety/parent work and policy versions.
- `sms_phone_suppressions`: safety routes and policy versions.
- `ai_disposition_reviews`: parent work, policy versions, and operation target
  revisions.
- `organizations`: reply-context organization-name revisions.
- `provider_sender_numbers`: reply-context sender-inventory revisions.
- `auth.sessions`: access-epoch invalidation for session changes. The sign-in
  row write itself still succeeds; the missing invalidation is why recovery is
  mandatory before serving is enabled.

Rows and counters already committed before capture-off are not rolled back.
Rows inserted, changed, or deleted during the window are not captured merely
because the functions are restored. A deletion can leave a source-missing
tombstone or stale derived state; do not infer coverage from an empty queue.
New inbound messages written during the window keep
`messages.inbox_inbound_revision = 0` unless a later write re-routes the
message: the integrity guard remains on, while the inbound-head capture
function is a no-op, and restore does not retroactively allocate revisions.

## Target identity and supported execution

`capture-off.sql` and `capture-restore.sql` are generated packets and must be
run only through `run_capture_packet.py`. Direct `psql -f` execution refuses
before any receipt table or function replacement is created. The runner
requires `--target-ref copflsklaefwzipsrjqz`,
`--i-understand-production`, a passwordless connection URL, and the password
in `INBOX_EMERGENCY_DB_PASSWORD` only. For Production it accepts only the
approved direct or shared-pooler endpoint, database `postgres`, and
`verify-full` with the pinned `supabase-prod-ca-2021.crt`; query options,
socket paths, and percent-encoded authorities are refused.

Disposable verification uses `--local-test` with `NODE_ENV=test` (or a CI
test flag), `127.0.0.1`, and the runner's 55400–55599 port range. The runner
sets a distinct transaction-local `local-test` target plus
`inbox.emergency_local_test = 'on'`; the packets additionally require
`inet_server_addr()` to be `127.0.0.1` or `::1`.

Supabase's documented managed connection strings identify a project through
the direct host or shared-pooler username. No reliable managed-Supabase
PostgreSQL setting or catalog fact independently exposes the project ref to a
SQL packet, so the packets deliberately do not pretend that
`current_database()`, server version, or an IP address is a second project
identity. `current_database() = 'postgres'` is checked only as the database
name; the endpoint/project binding remains the runner's fail-closed check.

## Required recovery after restore

1. Before applying `capture-restore.sql`, verify operators have not left any
   covered trigger disabled with `DISABLE TRIGGER`. The restore precondition
   requires every covered trigger to have `tgenabled = 'O'` and refuses with
   `INBOX_CAPTURE_OFF_TRIGGER_CATALOG_DRIFT` otherwise. Re-enable the trigger
   and retry only after inspecting that drift.
2. Apply `capture-restore.sql`. Its postcondition aborts unless every covered
   function's `prosrc` MD5 equals the exact body extracted from the approved
   migration files.
3. Keep `inbox_control.rollout.serving_enabled = false` and run the existing
   Inbox reconciliation tool from reconciliation PR **#725**:
   `scripts/inbox-reconcile-completion.mjs --recover-capture-bypass
   --apply-capture-recovery`.
4. Use the tool's own bounded recovery, route-edge repair, generation/boundary
   gates, collision checks, and receipt. Then wait for the normal projection
   worker to drain and run its completion/read-only evidence checks. Do not
   invent a second repair algorithm or enable serving as part of this packet.

The approved migration worktree does not contain PR #725's reconciliation
tool, so this packet deliberately does not copy or replace it. The operator
must use the reviewed #725 tool once that stacked work is available. The
recovery procedure is consistent with the production-install README: a
capture detach requires a dependency-aware packet followed by capture-gap
reconciliation; `serving_enabled=false` alone does not repair the write path.

## `auth.sessions` ownership evidence

`20261004050000_inbox_control_foundation.sql:4-7` makes the migration role
`postgres`, requires `SELECT` and `TRIGGER` on `auth.sessions`, and refuses a
missing canonical session table. The approved candidate catalog pin at
`experiments/inbox-production-install/function-owners.json` records
`inbox_bridge.capture_access` owned by `postgres`. The runbook's P5 probe
requires and records `has_table_privilege('postgres','auth.sessions',
'SELECT') = true`, `TRIGGER = true`, with the Auth ACL containing the
`postgres=ar*wdDxtm` entry. Therefore `postgres` can
`CREATE OR REPLACE FUNCTION inbox_bridge.capture_access()` while leaving the
Auth-owned trigger, ACLs, RLS, and table ownership intact. It cannot and need
not `DROP TRIGGER` on `auth.sessions`.

No covered source trigger is expected to require `DROP` for neutralisation.
The only ownership-sensitive case is `auth.sessions`, and function replacement
is the supported path for it.
