# T2-A transactional inbound-head rehearsal

This candidate is deliberately outside production migrations. It must run only after the offline source bootstrap completes, against the explicitly owned Docker container with no network or published ports. It does not contact any SMS provider or deployed database.

## Protocol

`001-inbound-heads.sql` installs `messages.inbox_inbound_revision DEFAULT0 NOT NULL`, a named nonnegative CHECK NOT VALID, and AFTER capture while holding the source table lock in one transaction. Existing messages form baseline0 without a historical-row validation scan. The proof records the heap filenode before/after and client-observed installation duration; constraint validation is a later explicit step. An inbound SMS with final nonnull org/conversation identity enters its destination by atomically inserting/incrementing `inbox_inbound_heads`. Updating that head holds its row lock until the surrounding message transaction commits or rolls back. No sequence or timestamp stands in for commit ordering.

Capture runs after the existing canonical BEFORE identity-stamping and source-row locking. An inserted inbound message, or an update entering a different org/conversation/channel/direction membership, receives a fresh destination revision. Moving out and back or deleting/reinserting cannot reset a retained head. Read/body/route or revision-only updates do not allocate arrivals. Revision self-update recurses through the ordinary trigger chain, but the membership comparison exits without another allocation.

The invoker BEFORE guard derives the exact allocator function owner from `pg_proc`; all inserts reject supplied nonzero revisions; ordinary update callers cannot forge a different revision, while the allocator's SECURITY DEFINER self-update can set the assigned revision. There is no `pg_trigger_depth` or caller-controlled session-setting authorization. The general UPDATE guard deliberately does not use an UPDATE OF target list; its zzz_ trigger name sorts after current canonical BEFORE triggers. Future trigger-order changes need review. The allocator owner, superusers and existing functions running as that owner remain privileged: inventory and compatibility review are mandatory. No defense against privileged schema owners is claimed.

The persistent head table has no canonical FK. Public/anon/authenticated/service_role privileges and direct trigger-function execution are revoked, with RLS enabled and no client policies. A future read API must return head/history from one snapshot and authorize its read boundary; this candidate does not expose that API.

## Checklist and execution

- [x] Candidate atomic SQL and source trigger comparison.
- [x] Offline guarded Python test harness design.
- [x] Full canonical bootstrap READY and marker verified (237 application migrations).
- [x] Candidate applied to offline canonical schema as actual application owner postgres.
- [x] PostgreSQL fault/concurrency/privilege proofs executed:18 passing checks.
- [x] Synthetic before/after overhead measured; supplemental2 checks passed.

Run `python3 experiments/inbox-projection/head-proof/run.py` from the worktree after coordinating exclusive fixture access. The harness creates only its synthetic org/messages and candidate schema additions in the disposable fixture. It does not reset preexisting tables. Applying the candidate a second time intentionally fails instead of silently accepting stale schema. Re-run requires a separately owned fresh fixture or an explicitly controlled test continuation; never drop source data automatically.

The harness starts an uncommitted holder and another actual PostgreSQL session, verifies the waiter appears blocked in `pg_stat_activity`, observes the old committed head, rolls back the holder and verifies that the waiter commits revision1. Additional tests cover canonical identity fill, multiple inserts, membership changes, deletion/reinsertion, non-arrival edits and direct-access denial. Timings include Docker/psql invocation and cannot certify production SLOs or hot-conversation capacity.

Source references: `081_conversation_id_unify.sql` (BEFORE fill), `20260815190000_true_dnc_property_lock.sql` (read mutation guard), `20260908120000_training_lead_guards.sql` (training guard). Body/route reply-dependency version capture is a different T2 deliverable and is not implemented here. Arbitrary multi-key legacy transactions can still deadlock; the protocol makes no deadlock-freedom claim.


## Observed results and integration consequences

`evidence.json` records18 passing checks. Installation while a canonical writer held a transaction failed at the2-second lock timeout and left neither partial column nor head table. Successful installation preserved the messages heap filenode, kept the nonnegative check unvalidated, and took49ms including Docker/psql transport. This is not a measured production DDL lock duration. A competing same-conversation writer was observed blocked in PostgreSQL; after holder rollback it committed revision1. The explicit legacy row-lock/head-lock inversion caused an actual deadlock, one transaction aborted, and retrying the entire aborted transaction restored exactly two arrivals. Existing production writer retry coverage remains unresolved; this experiment does not make legacy callers automatically safe.

`INSERT ... RETURNING` returned0 although a following SELECT read1. The supplemental UPDATE returned its old revision1 although the following SELECT read3. New DTOs and read-boundary RPCs must read authoritative final state in their intended snapshot, never treat outer RETURNING as the post-trigger revision. A later AFTER projection trigger can receive nested updated state and then the stale outer NEW; enqueue affected identity keys and recompute from authoritative rows. Do not write a projection's revision directly from stale outer NEW. A full projection-ordering integration is still a separate test.

The protocol transported9007199254740993 as explicit text without JavaScript Number conversion. The invoker guard denied service_role INSERT/UPDATE revision forgery and authenticated INSERT forgery; both could not read the head table and service_role could not update it. Neither ordinary role can assume the allocator owner. `privileged_message_referencing_definers` inventories same-owner SECURITY DEFINER functions, including functions that only read messages; this is a review set, not proof that each can modify a revision. Owner-definer writers are trusted privilege paths, not an allocator-only exemption. Privileged future writers and trigger ordering require explicit review.

`python3 experiments/inbox-projection/head-proof/supplement.py` runs repeatable post-install observations. Its control disables only the new capture trigger inside a bounded rollback-only transaction in the exclusive offline fixture; canonical guards remain enabled, and rollback restores capture. For100 inserted rows, three control samples took3.8–4.5ms server elapsed and82–84KB WAL insertion delta; three capture samples took13.6–16.3ms and197–225KB. These small local samples expose meaningful extra write cost, not production throughput or an acceptable budget. Each arrival now adds a source-row update and a head write; measure vacuum/WAL impact at representative volume before rollout. The recorded902 estimated dead tuples are asynchronous whole-fixture statistics including deliberate rollback tests, not an exact per-arrival count. No WAL production SLO, replica lag, HA or long-term bloat certification follows.

Both proof entry points refuse optimized Python (`-O`/`PYTHONOPTIMIZE`) before any Docker or database call, because their proof assertions must execute. Pure `python3 -O` invocation checks returned exit1 with that refusal for both scripts; no schema reinstallation or database rerun was performed for this guard change.

## Hardened entrypoint verification

`verify-preflight.py` passed six read-only checks recorded in `guard-evidence.json`: installed-candidate refusal happens before fixture writes, authenticated and service_role head SELECT/UPDATE fail specifically with SQLSTATE42501 permission denial, and both entrypoints reject optimized Python. Original install/concurrency evidence was preserved; the installed candidate was not reinstalled. Head/read/supplement runners use shared immutable fixture and cron guards, bounded subprocess timeouts, and cleanup for concurrent holder/waiter processes.
