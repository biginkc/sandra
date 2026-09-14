# Offline read-index comparison

Nine checks passed on the canonical PostgreSQL fixture at 1,000, 10,000 and 100,000 messages per conversation. This is a synthetic query-plan comparison, not production capacity certification. No application code or production migration was changed.

Run `python3 experiments/inbox-projection/index-proof/run.py` only with exclusive fixture access and no existing proof indexes. The runner refuses an existing index instead of dropping it. It rejects optimized Python before Docker access and uses the shared immutable container, image, offline-network and disabled-cron guard. SQL has lock/statement timeouts and subprocesses have bounded timeouts.

## Observed results

Second repeated samples, PostgreSQL execution milliseconds:

| Cohort | Existing history | Indexed history | Existing ID-ordered batch | Revision-ordered indexed batch | Late-only empty batch |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 0.328 | 0.056 | 12.356 | 16.073 | 0.081 |
| 10,000 | 0.154 | 0.058 | 16.285 | 11.885 | 0.084 |
| 100,000 | 0.238 | 0.172 | 279.424 | 12.204 | 0.095 |

At 100,000, the existing primary-key traversal rejected 111,650 rows to find 200 eligible rows. The new unread index supports the fixed revision boundary and revision/UUID ordering. After acknowledging revisions 1–200, all 99,800 later arrivals remained unread; the next plan used the unread index with zero candidate rows and zero filter rejections. The same checks passed at the smaller tiers. The query rechecks scope and eligibility in the UPDATE and does not use SKIP LOCKED.

The history index was selected at 1,000 and 10,000. At 100,000 the planner retained the existing created_at index, returning 52 rows below the sort/limit and rejecting 616 unrelated rows. This fixture therefore **does not establish bounded history work under arbitrary interleaving**. Its newest large conversation is favorable to timestamp scanning. A realistic interleaved conversation distribution and actual tenant statistics remain necessary; do not force this index globally based on this test.

A cursor page of 37 deliberately cuts through a ten-row timestamp tie. Two pages match the first 74 IDs exactly, using PostgreSQL's full timestamp text and UUID as the cursor. No JavaScript timestamp truncation is involved.

## Fixture and measurement conditions

Each cohort is one synthetic organization/conversation with inbound SMS only, a 179-byte ASCII body and NULL metadata. Ten rows share each microsecond timestamp. New data totals 111,000 rows, on top of prior T2 fixtures. Loading used separately committed batches of at most 1,000 with a 30-second statement timeout; client load times were approximately 213ms, 1,809ms and 18,434ms. These are harness loading observations, not ingestion throughput targets.

All canonical guards, the installed arrival-head allocator and `zzzz_inbox_t2_projection_dirty` remained enabled. Trigger identities/states are captured in `evidence.json`. No source guard was disabled, no head reset and no preexisting data deleted. This is **not** a comparative write-amplification measurement. Batch plan measurements execute the real UPDATE and roll back; PostgreSQL still generates WAL and tuple churn during rolled-back measurements.

`plans.json` contains both samples with EXPLAIN ANALYZE BUFFERS WAL. No cache was flushed; inserts, ANALYZE and index creation warm caches. Baselines were sampled as cohorts were added, while indexed samples see the complete table, so this is not a perfectly paired fixed-corpus experiment. No concurrent user load was present. The 1,000-row indexed batch was slower in this sample; indexes do not guarantee lower elapsed time for every workload.

The history index build took 84ms client time and occupied 8,740,864 bytes; the unread index took 116ms and occupied 8,650,752 bytes. Both are ordinary CREATE INDEX over the shared fixture, not concurrent production index migration rehearsals. Build timings include Docker/client overhead; the script runs ANALYZE before plan comparison. Query plans include planner row estimates and actual rows, buffers and WAL; these local samples do not establish production bloat, storage or vacuum budgets.

## Remaining production gates

Validate the actual mixed-tenant distribution, concurrent arrivals/read acknowledgements, lock ordering and whole-transaction retries. Revision/UUID traversal changes lock order. Add authenticated API/token/receipt behavior, real query parameterization and final rendered-snapshot semantics. Rehearse concurrent index creation and operational rollback separately before proposing a production migration. The read SQL here runs as postgres with explicit scope predicates; it does not prove end-user authorization.

## Adversarial newer-arrival supplement

`supplement.py` added exactly 10,000 newer messages in committed batches of 1,000: 5,000 in the target organization but another conversation, and 5,000 in another organization. All noise timestamps are September 2, after the target's September 1 timestamps. Original evidence remains unchanged; `noise-evidence.json` and `noise-plans.json` capture this separate comparison.

The exact target latest-50 IDs remained unchanged. However, PostgreSQL still chose `idx_messages_created`, rejected **10,617** unrelated rows, touched about **20,042 shared buffer blocks**, and took **4.186ms** in the second sample. Before noise it rejected 616 rows and took 0.172ms. This refutes a blanket claim that adding the scoped history index alone establishes bounded history work: the planner can favor the globally ordered path under this skew. No query hints, index drops or planner configuration changes were used. Query/statistics alternatives need their own measured follow-up before choosing a production fix.
