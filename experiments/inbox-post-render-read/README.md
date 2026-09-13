# Recorded post-render read acknowledgments

Private canonical T2 implementation with a request-scoped Supabase repository and
two disabled-by-default Next routes. No production migration, enabled HTTP route
or browser acknowledgment wiring is included yet.

`detail` reads the existing bounded authenticated history/head function and capture
generation in one statement snapshot, and records an opaque boundary. It does not
change message read state. `acknowledge` accepts only that server-recorded boundary
and an ordered batch number. A batch updates at most 200 eligible inbound SMS rows
and commits its immutable receipt in the same transaction. Repeating a completed
batch returns the original receipt, including if someone later marks a message
unread. Arrivals after the captured head remain unread even if backdated.

The caller must invoke acknowledgment only after the matching detail has rendered;
the database cannot establish that a person saw the page. The initial five-minute
boundary and ten-minute execution lifetime are engineering trial values. The
current caller must have a live authenticated session for each batch. This is not
yet a detached durable worker integration.

Current SQL tests passed six groups: bounded snapshot without read mutation; 451
eligible messages across three batches with later arrival exclusion; immutable
replay; private-storage and unknown-boundary denial; expiry; current membership
suspension and session deletion. The runner verifies exact installed function
bodies before reuse. The first fixture seed attempt used a wrong string operator;
it failed before inserting seed data and was corrected before the successful run.
Evidence hashes bind the successful source. Trusted SQL claims are not proof of
JWT verification or HTTP behavior.

Independent review identified and corrected a capture-generation race by holding
`FOR SHARE` on generation metadata for a whole batch, and added an explicit current
conversation existence check. No arrival-head lock is acquired. Six real concurrent-session groups then passed: generation reset serialization,
locked-message noncompletion, later arrival and identity re-entry exclusion, DNC
rollback, expiry during a lock wait, and an actual PostgreSQL deadlock followed by
same-boundary/batch retry. The recorded deadlock victim was the acknowledgment;
its aborted transaction persisted no read or receipt.

The 200-row mutation limit does **not** bound every database operation: preserving
legacy semantics currently requires checking revision coverage and every linked
property across conversation history. Wide-history query plans, guard indexing or
maintained metadata must be evaluated. Property-first locks can deadlock with
legacy message-first writers. The eventual adapter must retry the entire database
transaction on 40P01/40001 with the same boundary and batch, not retry one statement.
No other error class is automatically retryable.

The application repository preserves raw microsecond timestamps and decimal
revisions, accepts outbound revision zero, and rejects missing canonical revision
coverage. An initial review hypothesis that outbound revisions could be null was
refuted by the actual NOT NULL/default-zero column and server-owned revision guard;
the stricter decoder was retained. It retries fresh whole-RPC transactions only for structured 40P01/40001
results using the same boundary/batch. Nineteen focused application tests passed,
including both route flags, cross-site/body guards and lost-response behavior.
Both routes return 404 before constructing a client unless
`INBOX_WORKSPACE_SERVER_ENABLED=1`; no environment was enabled. Missing schema
or grants fail closed. The initial detail endpoint explicitly rejects unsupported
cursors rather than silently returning page one.

Also outstanding: capture installation/baseline safeguards, cleanup/admission,
history cursors and context parity, real PostgREST/JWT proof, post-render UI
generation binding, measurable first-open/revisit performance, and production
rollout.
