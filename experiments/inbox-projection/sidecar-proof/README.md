# Sidecar measurement alternative

This rehearsal does not replace the approved revision-column design. It tests a narrow alternative on the owned offline canonical fixture. Run `python3 experiments/inbox-projection/sidecar-proof/run.py` only while holding exclusive fixture write ownership.

The private sidecar captures finalized identity in an AFTER trigger, upserts the same persistent per-conversation head, then inserts a narrow arrival record instead of issuing a second UPDATE to the wide canonical message. Absent mappings mean baseline revision zero. Identity exit/delete clears the mapping; destination entry allocates a fresh revision. Heads remain after deletion. The read join matches message ID, organization, and conversation so an obsolete membership cannot supply the revision.

Eleven checks passed: existing inbound baseline, membership entry, body edit, destination move, return, channel exit/reentry, delete with retained head, same-ID reinsertion, savepoint rollback, and outer rollback restoring the committed candidate. These checks are bounded correctness coverage, not the full canonical parity suite.

Every alternative installation and synthetic insert runs inside a transaction ending in ROLLBACK. Only the capture trigger is temporarily disabled; canonical triggers and revision guards remain. The harness verifies exact container ID, purpose marker, network none, unpublished ports, cron disabled, candidate trigger enabled, and sidecar schema absent before/after runs. There is no destructive reset. The candidate remains installed and enabled.

## Observed A/B results

Three alternating trials per variant use identical 100-row synthetic batches, identifiers and approximately 1.5 KB bodies, under postgres. Server write timing excludes Docker startup, organization seeding and alternative DDL. WAL insertion LSN covers nested trigger writes, but is instance-wide and can include background activity. Rolled-back trials still emit WAL.

| Variant | Median write ms | Median WAL bytes | Detail 50 execution ms | Boundary 50 execution ms |
| --- | ---: | ---: | ---: | ---: |
| candidate | 36.475 | 280904 | 0.073 | 0.043 |
| sidecar | 16.961 | 172624 | 0.729 | 0.707 |

The sidecar reduced write work in this fixture, but both bounded read queries were slower with its extra join. Complete EXPLAIN ANALYZE BUFFERS JSON plans are retained in evidence.json. Reads select 50 detail rows or 50 unread IDs at an arrival boundary; they are executable SQL prototypes, not the future production endpoints. The sidecar had more shared-buffer accesses. Small fresh tables, planner statistics, wide rows and cache state limit extrapolation; this is not a production throughput result or enough evidence to choose a storage model. A larger realistic corpus, statistics, alternate detail-first join shapes, canonical authorization and full mark-read mutation tests remain necessary.

The sidecar DOES NOT eliminate row-before-head lock inversion. Source UPDATE already locks its message tuple before the AFTER trigger locks a head. Two legacy multi-statement writers can still lock a message and a head in opposite order. Whole-transaction deadlock retry remains required; this rehearsal does not supersede the candidate's demonstrated deadlock result.

No application changes, production migration, external providers, or commits were performed.

## Comparison boundaries

Do not compare these write medians directly with the earlier head-proof supplement. That script used body `T2 WAL probe` (12 bytes), generated message UUID defaults and a new conversation per trial. This script uses `repeat('synthetic body ',100)` (1,500 bytes), fixed MD5-derived UUIDs, and the same rolled-back organization/conversation in every trial. Its clock measurement lives in a server DO block instead of separate psql statements. The later fixture has also accumulated more aborted tuples/WAL; we did not measure a causal decomposition. The larger body is a verified input difference, not proof that it explains the entire timing difference.

Each measured transaction contains exactly 100 new source messages in one organization/conversation. Sidecar transactions contain 100 arrival records plus the primary-key index and `(org_id,conversation_id,revision,message_id)` index. Candidate transactions reuse the existing canonical indexes and revision-column installation; sidecar transactions keep those canonical structures in place. Whole-table live/index/dead-tuple cardinalities were not frozen or recorded per sample. The order was candidate/sidecar, sidecar/candidate, candidate/sidecar; each query has one measured execution per transaction, with no separate warmup or ANALYZE. Reads follow writes, so they are not cold-storage tests.

The retained first plans show both variants using the same `idx_messages_org` source scan (100 rows). The sidecar adds a nested loop whose `arrivals_boundary` index-only scan executes 100 times, averaging 50 rows per loop before the message-ID join. This is a concrete inefficient plan in the tested shape, not an unavoidable sidecar cost. The arrival primary key exists, but was not chosen in that plan. Current small-table estimates/index ordering and joining before LIMIT are relevant hypotheses to test. A detail-first limited subquery with primary-key lookup, warmed repeated reads, and representative ANALYZE statistics should precede any recommendation. No alternative is selected by this rehearsal.

## Correctness assertion repair

The initial SQL test helper used `IF NOT(condition)`, which incorrectly accepts a NULL result from a missing-row scalar subquery. Its original `evidence.json` is preserved for the historical timings; that receipt's correctness claims were provisional. The helper now uses `(condition) IS DISTINCT FROM TRUE`. A correctness-only rerun passed all eleven original checks and an added negative control proving a missing row raises the expected exception. `correctness-evidence.json` records the corrected runner hash and supersedes only the older correctness assertions. No benchmark was rerun. The alternative schema was rolled back and the committed capture trigger was verified enabled.

Run only the corrected checks with `python3 experiments/inbox-projection/sidecar-proof/run.py --correctness-only` while holding exclusive fixture write ownership.
