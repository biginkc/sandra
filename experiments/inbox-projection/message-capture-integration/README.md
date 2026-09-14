# Message-direct dependency capture and persistent unknown identities

**24 checks passed**: 19 in `evidence.json`, five in `supplement-evidence.json`. This private PostgreSQL candidate captures actual message OLD/NEW changes after canonical BEFORE identity stamping. It preserves all earlier proof objects and does not modify application code or install a production migration.

Authority is the adjacent [dependency capture design](../dependency-capture-design.md), the approved technical specification's source-specific version field map, the actual canonical message schema and the known/unknown compute functions. Queued/paused version treatment below is explicitly an implementation assumption; it is not promoted into a universal approved status rule.

Run with exclusive offline fixture access:

```sh
python3 experiments/inbox-projection/message-capture-integration/run.py --run-owned-fixture
python3 experiments/inbox-projection/message-capture-integration/supplement.py --run-owned-fixture
```

The initial runner refuses a previously installed schema before writes. Both entrypoints refuse optimized Python before external access and use shared immutable container/image/network/cron guards and bounded subprocess/SQL timeouts. Concurrent processes have bounded readiness/lock observation and cleanup in `finally`. Only newly created synthetic rows are updated/deleted. Original source triggers are compared before/after; the installed arrival allocator and earlier smaller dirty trigger remain enabled.

## Installed private structures

- `sender_groups`: persistent typed UUID for each exact `(org, raw sender)`; mappings survive empty groups and source deletion/reinsertion. Nonempty whitespace remains a valid legacy key. Empty/NULL raw values are excluded. Neither normalization nor trimming defines this identity.
- `sender_buckets`: bounded `(org, md5(raw))` allocation locks. MD5 selects a lock/search bucket only; exact raw text equality with C collation determines identity. Hash collisions do not alias raw strings. The helper rechecks exact equality after locking before insertion. This avoids placing unbounded raw text in a btree uniqueness key; a 4,000-character raw sender passed.
- `dirty`: persistent generation keyed by `(org, target_kind, target_id)`, where kind distinguishes known conversation UUIDs from unknown sender-group UUIDs.
- `versions`: persistent `message_content`, `known_reply` and `unknown_action` counters with org-scoped UUID targets. Known-reply aggregate changes also invalidate a captured conversation when a new message arrives; relying solely on versions of previously existing message IDs would miss that event.
- `route_edges`: current per-message `(org,message_id,conversation_id,normalized customer route)` edges, indexed for later `(org,route,message_id)` traversal. Inbound uses from_address; outbound uses to_address. Ten US digits gain `+1`; eleven digits beginning with 1 gain `+`, matching the known compute. Unknown grouping continues to use exact raw sender independently.

All private tables have RLS enabled and no PUBLIC/anon/authenticated/service_role access. Functions and schema are similarly private. No canonical foreign keys are introduced. Persistent IDs/counters remain after source deletion; relationship edges are removed/moved as the source changes. This is newly captured data only: existing messages have **not** been backfilled into the registry, versions or edges.

The registry's exact-uniqueness invariant is enforced by the private serialized helper, not by a large raw-text unique constraint. Trusted postgres/direct owner writes can violate it and are outside the ordinary caller guarantee. The collision-safe equality rule is implemented, but no deliberately constructed MD5 collision was generated in this proof. Concurrent first insert and rollback behavior were tested on actual source writes.

## Field and version behavior

Known dirtiness compares the full direct field set: id, org, conversation, contact, property, channel, direction, status, created_at, body, from/to address and read_at. Unknown dirtiness compares its actual source fields including dismissed_at; read/status alone do not alter legacy unknown grouping. Both eligible OLD and NEW typed identities are marked on transitions, including departures that now need a tombstone.

Content versions compare id/org/conversation/contact/property/channel/direction/body/from/to address and conservatively any metadata change. Read receipts, ordinary delivery status and display timing do not invalidate known-reply content. Dismissal changes the unknown-action counter independently. Unrelated conversation counters remain unchanged.

As an explicit conservative candidate assumption, status entry/exit across the queued-or-paused eligibility boundary also increments message-content/known-reply versions. Queued-to-paused stays within the excluded set and does not. This classification requires validation against the full prepared-reply dependency contract before activation. Status is not an unknown eligibility filter, so these status-only transitions do not automatically invalidate unknown actions.

Pure metadata changes increment content versions without inventing summary output dependencies. Arrival revision-only nested self-updates return without dirty/version/edge work. Display status/timing fields not emitted by current summaries are not added as new summary semantics. Old/new identity and content changes can conservatively invalidate unknown-action preparation even when that field alone would not change raw-group eligibility.

## Actual evidence

The first proof verifies finalized canonical conversation identity with exactly one capture increment despite the nested arrival self-stamp; read/status/timing separation; body/route changes; queued/paused transitions; metadata; property-link replacement; exact raw/whitespace/cross-org groups; long raw addresses; dismissal; match/unmatch; raw-key replacement; SMS/email transitions; org/conversation movement; delete/reinsert persistence; complete rollback; concurrent first-group allocation; unrelated reply-version isolation; private ACLs and preserved prior triggers.

Two separate transactions inserted the same new raw group. The second was observed blocked through `pg_blocking_pids`, then completed after the first committed. Exactly one persistent UUID remained, with two dirty generations. A separate explicit rollback test compared all private tables before/after and found no leaked registry, counter or edge changes.

The supplement verifies inbound/outbound route direction, source UUID replacement, unknown tenant movement, equal-timestamp grouping and microsecond dirtiness, plus NULL/empty raw exclusion. Equal-timestamp unknown winner behavior remains undefined in the legacy query; the candidate does not invent a UUID ordering rule for it.

## Locking, limits and next gates

Capture touches at most OLD/NEW targets and current source edges; it does not scan children or compute summaries. New raw buckets are acquired in org/hash/raw order, then distinct typed dirty keys and version keys in stable order, then source edges. Existing-row registry lookup avoids unnecessary bucket writes. This does not prove global deadlock freedom: canonical source/head locks already exist, multi-statement writers can reverse source order, and the older lab trigger takes additional locks. Enabled writers still require whole-transaction retry for deadlock/serialization failures.

The earlier smaller dirty trigger **also runs** against its separate proof tables. The new typed generations do not replace or automatically feed the older known-summary worker's queue. Duplicate lab effects are not a proposed production topology and provide no comparative write-amplification or throughput evidence. A production design must converge on one reviewed capture/publication protocol.

Parent property/contact/review/thread capture, consent/suppression fanout, durable checkpointed jobs, expiry scheduling, registry/edge backfill, unknown worker/action integration and cutover are not implemented here. Row triggers cannot detect their own disablement, replica-mode bypass, TRUNCATE or unsafe restore. Privileged paths, backfill races and capture-generation repair must be fenced before relying on these versions or edges. Private counter correctness is not end-user authorization, an enabled bulk command or complete reply-safety certification.

## Review corrections retained separately

The original registry used an unchanged bucket row lock after a missing-group
lookup. That is insufficient under REPEATABLE READ: a waiting transaction can
retain an older snapshot without seeing the newly inserted exact group. The
revised helper uses an `INSERT ... ON CONFLICT DO UPDATE` bucket write barrier.
An older snapshot then fails with SQLSTATE40001; the caller must retry its whole
transaction. The existing-bucket concurrent-miss proof records this failure,
checks that no source/registry data leaked, and verifies retry shares one ID.
Earlier setup and receipts are preserved with `before-rr` names.

A second correction replaces `to_jsonb(OLD/NEW)` with explicit identity fields,
avoiding serialization of whole message bodies and metadata into the capture's
side arrays. The necessary field-change comparisons remain. The final retained
repeatable-read receipt refers to the revised setup hash. This reduces unnecessary
work by construction but does not establish a measured latency or WAL improvement.
Neither correction adds retry handling to production writers.
