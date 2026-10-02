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
migration transactions. Because the original failure was a 1-in-4 race, the fix is reasoned plus not-reproduced,
not proven; the residual risk is a retry-able 40P01 for one in-flight insert during a ~100 ms window.
