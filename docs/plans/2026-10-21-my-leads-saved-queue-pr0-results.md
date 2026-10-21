# My Leads saved queue — PR-0 results (measurement and go/no-go)

Plan: `docs/plans/2026-10-21-my-leads-saved-queue.md` (rev 5, SHA256 prefix 93756052f75e1551). Measured 2026-10-21 on prod
(`copflsklaefwzipsrjqz`, Postgres 17.6), read-only (`begin transaction read only`, no writes, no migrations). No lead data
was read out; only counts, ids of members, and timings.

## Plain-English summary

- **The saved-queue design (A) is a NO-GO under MLQ-11.** The deciding measurement: recomputing 20 leads costs
  1.7–2.6 s against the 150 ms limit (11–17× over). A limited fingerprint prototype also ran 2.3–15.7 s for the
  1,755-lead queue (limit 250 ms); that result is concerning but inconclusive, since the prototype both omits paths and
  over-counts work. Per the ruling, A stops; no part of it ships.
- **No narrow fix (C) clears MLQ-1.** The attribution below is partial (about 2.6 s of 13.3 s is not assigned to a CTE),
  but even if all of that remainder belonged to the top two CTEs they would hold at most ~62%, below the 70% bar. No index
  or code change ships in this PR.
- **Working hypothesis: the database CPU is slow or contended.** A plain "count to 200,000" test takes 0.5–1.0 s on prod and
  0.018 s on a laptop, and got slower across five runs. This is consistent with a throttled or shared CPU, but it is not
  proven. Supabase CPU / burst-credit metrics and wait-event sampling would confirm or rule it out (see C).
- **Recommendation:** check the compute metrics first; if they show CPU saturation or credit exhaustion, move to a larger,
  non-burstable tier (needs Jarrad's spend approval) and re-measure.

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
does not narrow, plus `lg`'s whole-queue receipt read. That floor is why a per-lead recompute cannot reach 150 ms on this
instance.

pg_stat_statements (since 2026-10-06): `fn_my_leads_badge…` 3,140 calls, mean 3,740 ms.

### Per-CTE attribution, 1,755 member, full queue (partial)
`EXPLAIN (ANALYZE, BUFFERS, TIMING, FORMAT JSON)` of the verbatim 20261021090000 body as a prepared statement with
`plan_cache_mode = force_generic_plan` (as the function runs). Execution 13,312 ms (11,346 ms on a second run);
generic-plan planning 1,305–1,321 ms on first use of a connection.

Method and its limit: exclusive time per node, grouped by the CTE subplan the node sits in. **CTE Scan nodes were set to
zero** rather than credited to the producing CTE, and CTEs under 5 ms were dropped from the output. So the table does not
reconcile to the execution time; the gap is shown as "unattributed".

| CTE | ms | % of 13,312 ms |
|---|---|---|
| main (final joins/projection: fl, hd/hdt, tm, inlined CTEs) | 3,811 | 29% |
| q0 (`my_leads_queue_rows`) | 1,865 | 14% |
| mf | 1,318 | 10% |
| mx | 1,291 | 10% |
| base | 850 | 6% |
| en | 768 | 6% |
| ev | 476 | 4% |
| inb, evx, lo, camp, cm, tu, apx (62, 56, 53, 45, 36, 34, 11) | 297 | 2% |
| **attributed total** | **10,676** | **80%** |
| **unattributed** (zeroed CTE Scan time, nodes < 5 ms, EXPLAIN timing overhead) | **~2,636** | **~20%** |

Top single nodes (second run): q0 function scan 1,450; main hash join 1,293; mx `idx_messages_property_created_id`
×1,755 loops 779; ev `idx_lead_events_property_created` ×1,755 514; mf hash join 512; mx `idx_messages_contact` ×1,755 411;
`properties_pkey` ×1,755 319; `contacts_pkey` ×1,755 318; `idx_step_runs_message` ×5,619 281.

Buffers: shared read 0, shared hit 123,146. Zero shared reads means the data was in Postgres's buffer cache; it does
**not** by itself rule out other waits (locks, LWLocks, CPU scheduling). `track_io_timing` is off (not changed), and no
wait-event sampling was taken during these runs.

### CPU evidence (supports a hypothesis; does not prove it)
| test | prod | local laptop PG 17 |
|---|---|---|
| `count(*) from generate_series(1, 200000)`, 5 runs 1 s apart | 496, 566, 687, 810, 1,020 ms | 17–22 ms |
| `count(*) from generate_series(1, 1000000)` | 3,607 ms | — |
| 1,755 primary-key probes (plpgsql loop) | 377 ms (0.21 ms each) | — |
| 1,755 calls of `my_leads_add_business_days` / `acquisition_working_deadline` | 329 / 318 ms | — |

Hypothesis H1: the instance's CPU is throttled (for example a burstable tier out of credits) or heavily shared.
- Supports: a pure-CPU benchmark is 25–55× slower than a laptop; it got slower across five runs; per-probe index cost is high.
- Does not prove: a laptop core is not a calibrated baseline; rising times could also come from other load in that window.
- Would confirm: Supabase compute size and CPU / burst-credit graphs for the test window; `pg_stat_activity` wait-event
  sampling while the classifier runs; repeating the benchmark at a quiet time.

### Other database load (pg_stat_statements since 2026-10-06, share of total execution time)
| query | share | calls | mean |
|---|---|---|---|
| Supabase Realtime WAL polling (`SELECT wal->>… as type …`) | 43% | 1,054,075 | 148 ms |
| PostgREST `set_config(search_path, role, …)` | 17% | 835,656,528 | ~0 ms |
| `webhook_events` processed_at update | 4% | 21,364 | 613 ms |
| `fn_my_leads_badge…` | 3% | 3,140 | 3,740 ms |

Hypothesis H2: Realtime polling competes with My Leads for CPU. Execution-time share is not CPU utilization (it includes
waits and overlaps across backends), so this is a lead, not a finding. One pg_stat_activity snapshot showed 11 active
Realtime polling backends and no lock waits on the classifier. Would confirm: per-query CPU from the Supabase metrics, or
wait-event sampling showing the polling backends on CPU while the classifier runs.

### MLQ-11 fingerprint — limited prototype benchmark (ad-hoc SQL, not a migration)
This is **not** a replay of the production read pattern. It is six sequential runs of one ad-hoc query in one session.

What it hashes: `(ctid, xmin)` over the lead, contact, queue state, open episode, tasks, offers, attempts, calls, notes,
events, Norma requests, obligations, dead letters, drafts, strip overrides, ledger by property and by message id, siblings
and their attempts/events/enrollments, lead + contact-only + sibling messages, step runs by message and by enrollment,
enrollments, sequences and steps.

What it omits (would add cost): stamp-referenced inbound message lookups, foreign-receipt queue-membership bits, the
org/member fingerprint and the membership id-set hash.

What it over-counts (would remove cost): the lead's own messages are hashed twice (as lead messages and again as sibling
messages, because the lead is its own sibling); messages, step runs and ledger rows are hashed without the classifier's
filters (channel, direction, `created_at <= p_at`), so the message set is broader than the classifier reads.

| fp(1,755) runs | 9,983, 3,375, 3,393, 2,312, 3,837, 15,712 ms |
|---|---|
| median / max (6 runs; too few for a real p95) | ~3,600 ms / 15,712 ms |
| 20-lead recompute (`_ids`, 20 ids; the real function, 3 runs) | 1,658–2,570 ms |

Even the fastest run (2.3 s) is 9× the 250 ms limit, so the omissions and over-counting would have to cut it by ~90% to pass.
The production read pattern (3 tabs × 30 s page + badge + facts) needs roughly four whole-queue fingerprints per 30 s per
member; that pattern was not replayed.

### Shadow-overhead claim (~1.05×)
Not supported. A shadow read runs the live classifier plus the cache path (fingerprint + recompute of changed ids) in one
statement; on this prototype the fingerprint alone costs 20–150% of the live classifier, so shadow would be well above
1.05×. Moot after NO-GO.

## B. Decisions

**MLQ-11: NO-GO for A.** The NO-GO rests on the real 20-lead recompute (1.7–2.6 s vs 150 ms), which fails the gate on
its own. The limited fingerprint prototype (2.3–15.7 s vs 250 ms, six sequential runs, not a production-pattern p95) is
concerning but inconclusive: it omits some dependency paths and over-counts others, so it is not a lower bound. Work on A stops; PR-1 … PR-5
are not started. The plan's named next option (WAL-fed dirty log with LSN fencing) is not built now.

**MLQ-1: no narrow fix clears the gate, with this uncertainty.** Attributed top two = main + q0 = 5,676 ms (43%). If the
entire ~2,636 ms unattributed remainder belonged to those two, they would hold 8,312 ms (62%), still below 70%. A run that
credits CTE Scan time to the producing CTE would make the split exact; it cannot lift the top two past 70% unless the
remainder estimate itself is wrong. No index or SQL change is in this PR, so the #911 parity harness is unaffected. Whether
the slow nodes are well planned is **not** settled by this PR: they use indexes, but per-probe cost and row estimates were
not reviewed node by node.

Candidates for a later C PR, after the compute question is answered and a re-measure (each needs its own parity run):
1. `q0`/`lg` whole-queue floor on the `p_ids` path (facts): today 1.4–1.8 s for one lead.
2. Generic-plan planning (~1.3 s on each new connection) for the plpgsql classifier.
3. A node-by-node plan review of `main`, `mx`, `mf`, `base` (row estimates vs actuals).

## C. Compute recommendation (needs Jarrad: spend)

- First, read the Supabase compute size and CPU / burst-credit graphs for 2026-10-21 and sample wait events during a
  classifier run (no spend). This tests H1 and H2.
- If H1 holds, move the database to a larger, **non-burstable** compute tier and re-run this PR's measurements. How much
  faster the queue gets is **unknown**: the benchmark gap (25–55×) suggests a large gain, but the classifier was not timed
  on other hardware, so no target time is claimed.
- If H2 holds, review the Realtime subscriptions behind the WAL polling. That is a configuration change, not a business
  rule, and is outside this PR.

## Method notes
- All prod SQL ran inside `begin transaction read only; set local statement_timeout=…`; results were returned through
  `raise exception 'PERF …'`. No temp tables, no writes, no settings changed.
- The EXPLAIN used the verbatim function body with `p_org/p_member/p_at/p_ids` bound as `$1..$4` of a prepared statement.
- Timings vary run to run by up to 5×; the tables report every run, not a best case.
