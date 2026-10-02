# Inbound persist burst: A/B/C (local 55329 sandbox only)

Same machine, same seed (50k properties / 250k messages), 5 reps with rotated state order. **A** = filter-cache migrations reverted (origin/main
before 1088ac0c). **B** = 20261002110000 + 110050 (cache triggers, full refresh on every insert). **C** = B + 20261002110055 (insert fast path).
Workload (`scripts/filter-volume/inbox-burst.mjs`): the `insertInboundMessage` path of `src/lib/messaging/inbound.ts` as one transaction per message:
dedupe lookup, `messages` insert (thread minted by trigger), `message_threads` AI-state clear. Not included: `sms_inbound_intents`/`webhook_events`
writes and the PostgREST hop. Laptop + Docker disk, pool of 70, so read the deltas. Latency = begin->commit per message (ms), 5 reps pooled.

| burst | state | n | p50 | p95 | p99 | max | median per-run p99 | errors |
|---|---|---|---|---|---|---|---|---|
| 50 concurrent, SAME property | A | 250 | 144.3 | 232.6 | 249.3 | 260.4 | 234.9 | 0 |
| 50 concurrent, SAME property | B | 250 | 332.5 | 597.6 | 681.4 | 699.7 | 518.2 | 0 |
| 50 concurrent, SAME property | C | 250 | 193.6 | 327 | 394 | 402.8 | 324.4 | 0 |
| 50 concurrent, 50 different properties | A | 250 | 23.2 | 33.8 | 34.6 | 34.9 | 30.8 | 0 |
| 50 concurrent, 50 different properties | B | 250 | 89.6 | 128 | 130.8 | 131.1 | 107.4 | 0 |
| 50 concurrent, 50 different properties | C | 250 | 100.4 | 163 | 179 | 180.5 | 127.7 | 0 |
| 200 msgs / 10 s, 20% same property | A | 1000 | 7.7 | 18.3 | 23.1 | 38.3 | 21.8 | 0 |
| 200 msgs / 10 s, 20% same property | B | 1000 | 9.1 | 22.8 | 29 | 36.8 | 28.5 | 0 |
| 200 msgs / 10 s, 20% same property | C | 1000 | 10.6 | 26.7 | 31.9 | 94.6 | 30.8 | 0 |

Lock-wait samples (10 ms `pg_stat_activity` sampling of `wait_event_type='Lock'`, summed over reps):
* A/same50: {"samples": 107, "transactionid": 1348, "tuple": 54}
* A/diff50: {"samples": 14}
* A/mixed200: {"samples": 3645, "transactionid": 1}
* B/same50: {"samples": 223, "transactionid": 4163, "tuple": 253}
* B/diff50: {"samples": 43, "extend": 4}
* B/mixed200: {"samples": 3857, "transactionid": 4}
* C/same50: {"samples": 150, "transactionid": 2475, "tuple": 105}
* C/diff50: {"samples": 55}
* C/mixed200: {"samples": 3708, "transactionid": 1}

## Reading
* Same-property burst (the serialisation case): p99 A 249.3 -> B 681.4 -> C 394 ms; lock-wait samples B 4416 -> C 2580.
  The fast path removes about 40% of B's added latency, not all of it (C is still above A).
* 50 distinct properties: B 130.8 / C 179 ms vs A 34.6 ms. Not improved by the fast path, by design: each run starts from deleted probe
  messages, so every message is the FIRST for its property and must flip a flag (a real properties UPDATE). The fast path only skips properties whose flags already cover the row (the steady
  state for existing threads), which this burst does not exercise.
* Mixed sustained 200/10 s: p99 A 23.1 / B 29 / C 31.9 ms; medians within a few ms. No errors or deadlocks in any run.
* Remaining cost in C: flag-flip UPDATEs (inherent to a denormalised cache) and the FOR SHARE lock + extra property reads per insert.

## Correctness of the fast path (migration 20261002110055)
Skip only while holding a SHARED row lock on the property taken after the global-DNC barrier, with the coverage check re-run under a fresh snapshot after the lock; clearing
writers refresh with FOR NO KEY UPDATE, which conflicts with FOR SHARE, so a flag cannot be cleared between our check and our commit. Tests: trigger suite 33/33 incl. a
both-orders clearer-vs-skipper race (12 runs) and a randomised 6-worker concurrent workload (cache == truth afterwards). Mutation check: removing the `FOR SHARE` statement makes the race test fail.
Also: 45-case fixture exact; volume gate 22 cases, 0 count mismatches, max valid-baseline ratio 1.38; 5 cold lock-probe runs of the new migration: 5/5 clean, 0 errors, max blocked ~0.8 s.
Residual: a skipped insert that finds its flag newly cleared upgrades share -> no-key-update, which could deadlock with another upgrader on the same property (retryable 40P01).
