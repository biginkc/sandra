# Maintained model review — 2026-09-13

Independent read-only code review covered setup.sql, queue.sql and worker-once.py.
No demonstrated lost-wakeup or stale-publication defect was found. Completion
holds the dirty row while comparing acknowledged/current generations and deleting
the queue key; source capture cannot cross that boundary unnoticed. Expiry and
completion serialize through that same dirty row. Claims end before computation.
This review is not a runtime concurrency or crash proof.

The reviewer identified that the worker returned exit success for rejected
candidates/generations. The final worker now reports applied/retry/rejected totals
and exits nonzero for rejected/error/missing outcomes. It also claims one target
immediately before each computation, avoiding lease time consumed by earlier
items in a batch. Stale claims and revision conflicts remain explicit retry
outcomes. The final expiry integration receipt covers this corrected worker.

Root reviewed bounded expiry discovery: read candidates without projection locks,
then recheck revision/deadline through the established dirty-first wake primitive.
Two real overlapping scheduler processes and a separate worker passed against a
real canonical deadline. No process death, representative load, public access,
parent fanout, backfill/cutover or production deployment is claimed.

Evidence before the worker correction is retained under
expiry-evidence-before-worker-review.json. worker-evidence.json is an earlier
single-invocation observation without source hashes, not the final worker proof.
Use expiry-evidence.json for final worker source hashes and execution results.
