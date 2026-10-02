# PR A lock / backfill evidence (local disposable stack, never hosted)

Setup: Supabase CLI **2.109.1** (same version as `db-migrate-test.yml` / `db-migrate-prod.yml`), command
`supabase db push --include-all --local --workdir <sandbox>` (the workflows use `--include-all` with a linked
project; `--local` is the only difference, pointing at the sandbox stack on 127.0.0.1:55329). Dataset: 50,000
properties, 250,000 messages (20 leads x 5k), 11k tasks, ~101k property_lists. Migrations 20261002110000 then
20261002110050 were pending and applied by the CLI itself (not psql).

Probe (`scripts/filter-volume/migration-lock-probe.mjs`): three separate connections sampled every ~50 ms:
pg_locks waits + ACCESS EXCLUSIVE holders on properties/messages/tasks/property_lists/property_tags, the migration
backend's `xact_start`, and the latency of a concurrent single-row `insert into messages` and a
`select ... from properties limit 25`. State reset between runs by `revert-cache-migrations.mjs`.

## Results (5 warm/first runs)
| run | CLI exit | distinct migration xact_start | ACCESS EXCLUSIVE on properties | max blocked insert | max blocked read |
|---|---|---|---|---|---|
| 1 (cold) | 0 | 65 | ~1136 ms | 991 ms (1 insert error, message not captured; probe since records it) | 1104 ms |
| 2 | 0 | 65 | ~103 ms | 158 ms | 73 ms |
| 3 | 0 | 65 | ~50 ms | 122 ms | 63 ms |
| 4 | 0 | 65 | ~50 ms | 122 ms | 45 ms |
| 5 | 0 | 65 | ~103 ms | 101 ms | 115 ms |

* 65 distinct `xact_start` values = 1 DDL transaction (110000) + 64 separately committed backfill batches (110050).
  The CLI does NOT wrap a file in one transaction when the file has explicit begin/commit, so the batched design
  holds. Each backfill batch ~150 ms median / 433 ms max (measured earlier with the same function).
* The 110000 DDL is the only ACCESS EXCLUSIVE holder: ~50-100 ms warm, ~1.1 s cold (first index builds). Lock waits
  appear only inside that window; none during the backfill batches.
* Cache after the push: 4186 replied / 228 unread / 8334 open-task properties (matches the oracle counts).
* `scripts/check-migration-safety.mjs` inspects migration history/ordering (not file contents, so BEGIN/COMMIT is
  irrelevant to it): `node --test scripts/check-migration-safety.test.mjs` 60/60 pass, and the earlier read-only gate
  run accepted a pending file of this shape. The CLI accepted both new files.
* Lock-order test (`filter-cache-triggers.integration.test.ts`, "waits for the exclusive global-DNC barrier BEFORE
  taking row locks") re-run: pass.

Caveat: the first cold run shows a ~1.1 s write/read stall at 50k/250k during 110000; production is far smaller.

## Cold-run insert error: root cause (follow-up)
Probe now records SQLSTATE/message/where/statement. Three container-restart "cold" runs of the original migration:
one reproduced it - `40P01 deadlock detected` on the concurrent `insert into messages` (where: SQL function
`is_training_target` during startup, via PL/pgSQL `guard_training_customer_action()` line 12), at ~2.5 s, inside the
110000 DDL window; the other two had no error (insert max 100-137 ms). It is NOT a probe-side lock_timeout and NOT
from the new triggers (they did not exist yet): the DDL took ACCESS EXCLUSIVE on `properties`, then queued for
`messages`/others piecemeal, while the insert held `messages` and the training guard then needed `properties`.
A real webhook insert could hit this during the migration window (the deadlock detector aborts one side: the insert
gets 40P01 and must retry; if the migration is the victim, `db push` fails and rolls back, safe to re-run).
Fix (migration 110000): `lock table messages, tasks, property_lists, property_tags, properties in access
exclusive mode` as the first statement, children first and `properties` last (the order DML takes them), under the
file's `lock_timeout = '5s'`. Re-run after the fix, 4 container-restart runs with the pinned CLI: 0 insert errors,
max blocked insert 144-195 ms, max blocked read 68-150 ms, ACCESS EXCLUSIVE on properties 50-164 ms, 64-68 distinct
migration transactions. 
## Statistical proof of the lock-order fix (valid runs, disposable 55329 sandbox only)
Harness: `scripts/filter-volume/cold-runs.sh` = container restart (cold) + `revert-cache-migrations.mjs` + pinned CLI
`supabase db push --include-all --local` with the probe running 5 concurrent writers (messages insert, tasks insert,
property_lists insert, property_tags insert, properties update) and a reader. A fail-closed identity check
(`assert-sandbox-target.mjs`: container `supabase_db_sandra-filter-vol` on 55329, postmaster start = container start,
no `norma%` databases, workdir config port 55329) runs before every restart/revert/push.

Clean comparison (no injected delay): OLD 110000 failed or deadlocked in **3/5** runs; FIXED 110000 in **0/20**.

Separate stress variant (test-only 600 ms `pg_sleep` inside the DDL window to widen the race): OLD 8/8 migration failures
(11 writer deadlocks); FIXED 0/8.

The harness reproduces the deadlock (the migration itself is often the victim, which rolls back and fails the push), and the fix removes it: 0/28 fixed runs affected. With the fix the
worst blocked writer/reader across the 20 plain fixed runs was ~1.3 s (a one-off cold-run stall; typical 100-200 ms)
and ACCESS EXCLUSIVE on `properties` up to ~1.0 s; in the widened runs writers wait the injected 0.6 s plus overhead
(max ~0.9 s) and never error. Raw per-run JSON lines are in `scripts/filter-volume/results/` (gitignored; kept locally).

## lock_timeout on the up-front LOCK (`lock-timeout-check.mjs`)
A concurrent transaction held `ROW EXCLUSIVE` on `messages`. The pinned CLI push of 110000 failed after 5.8 s with
`canceling statement due to lock timeout (SQLSTATE 55P03)` at the `lock table` statement: nothing recorded in
`schema_migrations`, no cache columns, no functions (clean rollback). After releasing the holder, re-running the same
push applied 110000 and 110050 successfully (re-runnable).

## Incident note
An earlier batch of 41 harness runs had an empty `SBX_WORKDIR` and pushed once to the shared dev stack on 54329
(2026-10-02 09:30:38Z, one session; the 41 runs are void and their logs are preserved outside the repo). My objects were reverted there at
09:37:19Z. The harness now fails closed (see above) and never targets 54329.

## Residual risk (barrier-forced, `lock-order-forced.mjs`, 55329 sandbox, pinned CLI 2.109.1)
The single `LOCK TABLE` statement acquires its tables sequentially (children first, `properties` last).
* **Order X** - a writer already holds `properties` (FOR UPDATE), the migration's LOCK takes the child tables and waits on
  `properties`, then the writer inserts into `messages` after a varied delay (12 runs, delays 0-3500 ms): a real deadlock every
  time. Whoever has waited longer than `deadlock_timeout` (1 s) runs the detector first and is the victim:
  delay <= 900 ms -> **migration got 40P01 in 6/6** (rolled back cleanly, push fails, re-run); delay >= 1100 ms -> **the WRITER got
  40P01 in 6/6** and the migration succeeded. So a production writer CAN be aborted with 40P01 in this order.
* **Order Y** - a writer holds `messages` first, the migration queues on `messages`, the writer then touches `properties`:
  **0/12 deadlocks** (writer commits, migration then proceeds). This is the case the up-front LOCK order fixes.
Runbook: schedule the migration in a quiet window; on 40P01/55P03 from `db push` re-run once; app writers already retry
transient 40P01. The pattern (a transaction that locks `properties` before touching `messages`) is the only exposure.

## Guard function parity on the shared 54329 stack (read-only select, no writes)
Identity: container `supabase_db_sandra` id c67fbfb17ba8, database postgres, port 54329, postmaster start 2026-09-30 22:02:13Z.
`pg_get_functiondef` of `properties_true_dnc_lock_guard` and `serialize_property_safety_before_csv_consent` compared (body,
whitespace-normalised, plus LANGUAGE / SECURITY DEFINER / search_path attributes) with the latest CREATE OR REPLACE in
origin/main migrations (`20260815190000_true_dnc_property_lock.sql`, `20260816020000_csv_import_recovery_safety.sql`):
**both match exactly**; nothing to fix.
