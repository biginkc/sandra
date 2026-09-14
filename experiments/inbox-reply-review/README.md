# Authenticated reply capture + immutable frozen review

This private, disabled candidate sits on top of `inbox-reply-preparation` (canonical
recipient capture) and `inbox-reply-boundary` (context dependencies, PR #587). It adds
an authenticated capture RPC and a freeze step that renders bulk-reply drafts into an
immutable, requester-scoped review row. It does not expose a send, create a job, or
call a provider. Both public RPCs are gated behind a closed `inbox_reply_review.admission`
flag (`INBOX_REPLIES_NOT_ENABLED` unless explicitly enabled), separate from the
production schema.

`setup.sql` creates `inbox_reply_review.preparations`, made immutable by an
`immutable_row` trigger (no UPDATE or DELETE once inserted). `capture()` wraps
`inbox_reply_preparation.batch()` behind actor authorization. `freeze()`:

- Validates a bounded `{targets, drafts}` envelope (≤500 targets/drafts, no duplicates,
  rendered body ≤1600 UTF-16 units matching JS `String.length`, non-whitespace-only).
- Re-derives canonical recipient capture server-side and rejects any draft whose
  `dependencies` don't match the just-recomputed capture (`INBOX_REPLY_PREPARATION_CHANGED`).
- Is idempotent on `(org_id, requester_id, request_key)`: a replay with the same
  canonical input returns the frozen view; a replay with different input raises
  `INBOX_REPLY_IDEMPOTENCY_MISMATCH`.
- Recomputes time-only exclusions (window expiry, quiet hours) at freeze time using
  only the database clock, after all lock waits.
- Flags every conversation sharing a destination phone as `duplicateDestination` —
  never silently drops or picks one.
- Sets `expires_at = freeze_time + 5 minutes` (capped further by the earliest
  still-eligible recipient's own window), matching Fable's ruling that freeze
  validity is 5 minutes, not the spec's 15.
- Surfaces `blockers`: `empty` (zero eligible recipients), `recipient_limit`
  (>50 distinct eligible destinations), `duplicate_destination`.

`public-api.sql` wires `public.inbox_capture_reply_recipients(conversation_ids uuid[])`
and `public.inbox_freeze_reply_review(canonical_input text, idempotency_key uuid)` as
`SECURITY DEFINER`, default-closed via `require_admission()`, granted only to
`authenticated`, never `anon`/`service_role`.

## Status of the proofs in this directory

`run.py` (rollback-only, single connection) and `replay-concurrency.py` (two real
connections, verifies an in-flight freeze against a request-key lock actually waits,
then denies without leaking the frozen body once the actor's access expires
mid-wait) were authored against the marked owned fixture
(`sandra-inbox-projection-t2-db`, marker `sandra-inbox-projection-t2-owned-synthetic`)
but were never committed — they were recovered from an unpublished handoff copy and
have **not been re-executed** as part of assembling this PR, because that fixture
database is shared with other concurrent sessions in this handoff and these scripts
`DROP SCHEMA ... CASCADE` on `inbox_reply_review`/`inbox_reply_preparation`/
`inbox_reply_context` as part of their own safety checks and cleanup. Re-run them only
against an isolated fixture, or after confirming no other agent depends on those
schema names in the shared container. There is no `verify.py` in this directory yet
(unlike `inbox-reply-preparation`); source hashes have not been bound to a recorded
evidence file.

Remaining gates: cap enforcement/duplicate resolution at acceptance (a separate,
not-yet-written `accept()`); current actor/dependency/time rechecks at dispatch;
committed dispatch marker and account admission; receipt persistence and verified
callback reconciliation; review UI. No production schema, flags, credentials, or
provider calls are changed by these files.
