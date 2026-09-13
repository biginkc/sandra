# T2-A offline read-boundary SQL proof

Six checks passed against the existing offline237-migration canonical fixture with the column-based AFTER allocator enabled. The database agent finished its exclusive measurements before this proof began. This directory contains only an isolated protocol harness and evidence; no application API or production migration was added.

`run.py` refuses optimized Python before any external call, then verifies exact container ID against the bootstrap receipt, networknone/no published ports, running state, fixture marker and enabled head capture. It creates unique synthetic organizations/messages and one fictional DNC property. It never resets heads or disables canonical guards. A delete/reinsert test affects only a message created by that same run.

Run from the worktree with `python3 experiments/inbox-projection/read-proof/run.py`. Coordinate exclusive fixture access first. The script uses explicit Dockerhost and dockerexecpsql as the database owner, not a network connection. It may be rerun with new unique fixture IDs; it does not reinstall or reset the candidate. `python3 -O .../run.py` was checked and refused with exit1 before Docker/database access.

## What passed

- A single SQL statement with materialized head/history CTEs returned head451 and the latest50 messages while a later message/head transaction was still uncommitted. Neither uncommitted component leaked into the snapshot. The held transaction then committed.
- A fixed boundary acknowledged448 eligible records in batches200,200,48, then0. Older rows outside the50 displayed records were included. The three originally eligible records moved out, moved out/back or deleted/reinserted were excluded by current membership or fresh revision.
- The committed-late message and an even later arrival with a1990 created_at remained unread. Arrival revision, not timestamp ordering, controls acknowledgement.
- Another organization with the same conversation UUID, another conversation, outbound SMS and inbound email remained untouched by explicit scope predicates. This proves SQL scope, **not end-user authorization**.
- Read updates did not advance the arrival head.
- Permanent DNC was acquired through the canonical property disposition guard after a snapshot. The canonical read_at trigger rejected the batch; both selected records remained unread. The test does not depend on UPDATE executor order or claim that the unguarded row was physically updated first.

The read transaction uses no SKIP LOCKED:200 is a mutation/row-lock limit, and lock waits have a2-second timeout. Each batch has a15-second statement timeout and commits separately. The final zero-candidate statement and explicit remaining-count assertion establish completion for this fixture. No idempotency receipt, completed-operation replay behavior or automatic lock retry is implemented.

## Query plans and limits

`plans-initial.json` preserves the original run and `plans.json` retains the strengthened rerun’s actual EXPLAIN ANALYZE BUFFERS plans; the UPDATE plan also includes WAL instrumentation and was executed in a rolled-back transaction, verified to leave no read updates committed. The initial detail query measured0.332ms; the200-row update measured15.722ms. Those initial observations are retained in `plans-initial.json`; `plans.json` is the strengthened rerun with projection dirty capture enabled. Neither is a production latency claim.

The planner used `idx_messages_org`, examined453 matching-scope history rows and used a top-N sort for50. The batch scanned448 eligible rows and sorted before limiting200; its UPDATE joined against another scan. Therefore the result and mutation limits **do not establish bounded database work at large history cardinality**. A suitable org/conversation/order and unread-boundary index/query plan needs representative-volume evaluation before production. The small head table used a sequential scan despite its primary key; its15-row size does not demonstrate a scale defect or a production plan.

The harness runs as postgres with explicit tenant/conversation predicates. It does not install a SECURITY DEFINER API, call the owner-bypassing resolver as user authorization, implement Hugo membership rechecks, sign or validate tokens, bind a requester, enforce expiry, persist batch receipts, or observe browser rendering. The JSON “boundary” is an internal trusted test value encoded as decimal text. It is not an externally acceptable client input. A complete implementation must add all those controls from `read-api-contract.md`.

## Strengthened harness verification

The rerun checks the exact latest-50 IDs in descending order, with ordering explicit inside JSON aggregation. All six checks passed again. Original evidence is preserved as `evidence-initial.json` and `plans-initial.json`. Shared fixture guards now verify immutable container/image/configuration and disabled cron. Subprocesses have bounded timeouts; concurrent holder/waiter processes are cleaned up in `finally`, with a bounded readiness wait. Fixture organization names include their unique IDs to permit reruns without colliding with prior synthetic organizations.
