# My Leads saved queue — PR-0 results (measurement and go/no-go)

Plan: `docs/plans/2026-10-21-my-leads-saved-queue.md` (rev 5, SHA256 prefix 93756052f75e1551). Measured 2026-10-21 on prod
(`copflsklaefwzipsrjqz`, Postgres 17.6), read-only (`begin transaction read only`, no writes, no migrations). No lead data
was read out; only counts, ids of members, and timings.

## Plain-English summary

- **The database computer is the bottleneck, not one slow step.** A plain "count to 200,000" test takes 0.5–1.0 s on prod and
  0.018 s on a laptop: prod runs at roughly 1/30th to 1/55th of normal speed, and it got slower the longer we ran tests
  (the pattern of a throttled, burst-credit CPU). Every step of the queue is slow by the same factor. Nothing reads from disk:
  all data is already in memory.
- **The saved-queue design (A) is a NO-GO under MLQ-11.** Checking whether a saved row is still current costs 2.3–15.7 s for
  the 1,755-lead queue (limit 250 ms), and recomputing 20 leads costs 1.7–2.6 s (limit 150 ms). Per the ruling, A stops; no
  part of it ships.
- **No narrow fix (C) clears MLQ-1.** No one or two steps hold 70% of the time; the biggest two hold 43%. Every step already
  uses an index; each index lookup costs ~0.2 ms instead of ~0.01 ms because the CPU is throttled. No index or code change
  ships in this PR.
- **Recommendation: a larger, non-burstable compute tier** (needs Jarrad's spend approval), then re-measure. Separately,
  Supabase Realtime's change polling uses 43% of all database time since 2026-10-06 and is the main CPU competitor.

## A. Measurements

### Queue sizes (org `…0bbb`)
| member | leads |
|---|---|
| 6a4e4899… | 1,755 |
| b480bc44… | 445 |
| 7459021e… | 54 |

### Classifier wall time (direct calls of the STABLE functions, `p_at = now()`)
| call | run 1 | run 2 | run 3 |
|---|---|---|---|
| `my_leads_queue_rows` (1,755) | 2,452 ms | 1,538 ms | 1,413 ms |
| `my_leads_work_classified_ids(…, null)` (1,755) | 13,298 ms | 9,845 ms | 10,743 ms |
| `_ids(…, 20 ids)` (1,755 queue) | 1,658 ms | 2,257 ms | 1,981 ms |
| `_ids(…, 1 id)` (1,755 queue) | 1,814 ms | 1,414 ms | 1,698 ms |
| 445-lead member: queue_rows / full | 1,341 ms / 4,931 ms | | |
| 54-lead member: queue_rows / full | 205 ms / 555 ms | | |

The 1- and 20-lead calls are dominated by `q0` (the whole-queue `my_leads_queue_rows` call, ~1.4–2.3 s), which `p_ids`
does not narrow, plus `lg`'s whole-queue receipt read. That floor is why a per-lead recompute cannot reach 150 ms.

pg_stat_statements (since 2026-10-06): `fn_my_leads_badge…` 3,140 calls, mean 3,740 ms.

### Per-CTE attribution, 1,755 member, full queue
`EXPLAIN (ANALYZE, BUFFERS, TIMING, FORMAT JSON)` of the verbatim 20261021090000 body as a prepared statement with
`plan_cache_mode = force_generic_plan` (as the function runs). Exclusive time per CTE (CTE Scan nodes credited to the CTE
that produces the rows). Execution 13,312 ms (11,346 ms on a second run); generic-plan planning 1,305–1,321 ms on first use
of a connection.

| CTE | ms | % of exec |
|---|---|---|
| main (final joins/projection: fl, hd/hdt, tm, inlined CTEs) | 3,811 | 29% |
| q0 (`my_leads_queue_rows`) | 1,865 | 14% |
| mf | 1,318 | 10% |
| mx | 1,291 | 10% |
| base | 850 | 6% |
| en | 768 | 6% |
| ev | 476 | 4% |
| everything else (inb, evx, lo, camp, cm, tu, apx, …) | < 62 each | < 3% total |

Top single nodes (second run): q0 function scan 1,450; main hash join 1,293; mx `idx_messages_property_created_id`
×1,755 loops 779; ev `idx_lead_events_property_created` ×1,755 514; mf hash join 512; mx `idx_messages_contact` ×1,755 411;
`properties_pkey` ×1,755 319; `contacts_pkey` ×1,755 318; `idx_step_runs_message` ×5,619 281.

Buffers: shared read 0, shared hit 123,146 (all in memory). `track_io_timing` is off (not changed), but zero reads means
I/O time is nil: **the cost is CPU.**

### CPU evidence
| test | prod | local laptop PG 17 |
|---|---|---|
| `count(*) from generate_series(1, 200000)`, 5 runs 1 s apart | 496, 566, 687, 810, 1,020 ms | 17–22 ms |
| `count(*) from generate_series(1, 1000000)` | 3,607 ms | — |
| 1,755 primary-key probes (plpgsql loop) | 377 ms (0.21 ms each) | — |
| 1,755 calls of `my_leads_add_business_days` / `acquisition_working_deadline` | 329 / 318 ms | — |

Rising times under sustained load = CPU throttling (burstable instance out of credits, or a heavily shared CPU).

### Competing load (pg_stat_statements since 2026-10-06, share of total execution time)
| query | share | calls | mean |
|---|---|---|---|
| Supabase Realtime WAL polling (`SELECT wal->>… as type …`) | 43% | 1,054,075 | 148 ms |
| PostgREST `set_config(search_path, role, …)` | 17% | 835,656,528 | ~0 ms |
| `webhook_events` processed_at update | 4% | 21,364 | 613 ms |
| `fn_my_leads_badge…` | 3% | 3,140 | 3,740 ms |

pg_stat_activity snapshot: 11 active Realtime polling backends, no lock waits on the classifier.

### MLQ-11 fingerprint prototype (ad-hoc SQL, not a migration)
Hash of `(ctid, xmin)` over the plan §1 dependency rows for each of the 1,755 leads: the lead, contact, queue state, open
episode, tasks, offers, attempts, calls, notes, events, Norma requests, obligations, dead letters, drafts, strip overrides,
ledger by property and by message id, siblings and their attempts/events/enrollments, lead + contact-only + sibling
messages, step runs by message and by enrollment, enrollments, sequences and steps. It omits the stamp-referenced inbound
lookups and foreign-receipt membership bits, so it is a **lower bound** on the real fingerprint.

| fp(1,755) runs | 9,983, 3,375, 3,393, 2,312, 3,837, 15,712 ms |
|---|---|
| p50 / p95 (6 runs) | ~3,600 ms / ~15,700 ms |
| 20-lead recompute (`_ids`, 20 ids) | 1,658–2,570 ms |

The production read pattern (3 tabs × 30 s page + badge + facts) needs about four whole-queue fingerprints per 30 s per
member, i.e. ≥ 9 s of CPU per 30 s for one member at the best observed run. This would make the throttling worse, not better.

### Shadow-overhead claim (~1.05×)
Not supported. A shadow read runs the live classifier plus the cache path (fingerprint + recompute of changed ids) in one
statement; the fingerprint alone costs 25–150% of the live classifier here, so shadow ≥ 1.25×, not 1.05×. Moot after NO-GO.

## B. Decisions

**MLQ-11: NO-GO for A.** fp p95 ≈ 15.7 s (limit 250 ms) and 20-lead recompute 1.7–2.6 s (limit 150 ms). Both fail by
more than 10×. Work on A stops; PR-1 … PR-5 are not started. The plan's named next option (WAL-fed dirty log with LSN
fencing) is not built now; it would also need CPU this instance does not have.

**MLQ-1: no narrow fix clears the gate.** The top two CTEs hold 43% (< 70%). The expensive nodes are already index scans;
they are slow per probe, not badly planned. No index or SQL change is in this PR, so the #911 parity harness is unaffected.

Candidates for a later C PR, only after a compute change and a re-measure (each would need its own parity run):
1. `q0`/`lg` whole-queue floor on the `p_ids` path (facts): today 1.4–1.8 s for one lead.
2. Generic-plan planning (~1.3 s on each new connection) for the plpgsql classifier.

## C. Compute recommendation (needs Jarrad: spend)

- Move the database to a larger, **non-burstable** compute tier and re-run this PR's measurements. With a normal CPU
  (≈30× faster on the benchmark above), the full 1,755 queue would be expected near 0.3–0.5 s, though that projection is
  untested.
- Look at the Supabase Realtime subscriptions that drive the WAL polling (43% of database time). Reducing them is a
  configuration change, not a business rule, but it is outside this PR.

## Method notes
- All prod SQL ran inside `begin transaction read only; set local statement_timeout=…`; results were returned through
  `raise exception 'PERF …'`. No temp tables, no writes, no settings changed.
- The EXPLAIN used the verbatim function body with `p_org/p_member/p_at/p_ids` bound as `$1..$4` of a prepared statement.
- Timings vary run to run by up to 5× because of the CPU throttling; the tables report every run, not a best case.
