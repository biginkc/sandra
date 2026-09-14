# Authenticated reply capture + immutable frozen review

This private, disabled candidate sits on top of `inbox-reply-preparation` (canonical
recipient capture) and `inbox-reply-boundary` (context dependencies, PR #587). It adds
an authenticated capture RPC and a freeze step that renders bulk-reply drafts into an
immutable, requester-scoped review row. It does not expose a send, create a job, or
call a provider. Both public RPCs are gated behind a closed `inbox_reply_review.admission`
flag (`INBOX_REPLIES_NOT_ENABLED` unless explicitly enabled), separate from the
production schema.

`setup.sql` creates `inbox_reply_review.preparations`, made immutable by an
`immutable_row` trigger (no UPDATE or DELETE once inserted from a non-superuser
role — TRUNCATE, `session_replication_role='replica'` and `DISABLE TRIGGER` all
bypass it too, but all three need superuser/table-owner privilege that
`authenticated`/`service_role` never hold here). `capture()` wraps
`inbox_reply_preparation.batch()` behind actor authorization. `freeze()`:

- Validates a bounded `{targets, drafts, template}` envelope (≤500 targets/drafts,
  no duplicates, `template` a non-empty string ≤1600 UTF-16 units, rendered
  `drafts[].body` ≤1600 UTF-16 units matching JS `String.length`, non-whitespace-only).
- Re-derives canonical recipient capture server-side and rejects any draft whose
  `dependencies` don't match the just-recomputed capture on a **first-time** freeze
  (`INBOX_REPLY_PREPARATION_CHANGED`).
- Is idempotent on `(org_id, requester_id, request_key)`, keyed on **client intent**
  — the sorted `targets` plus the raw `template` string — not on the server-rendered
  `drafts`/`dependencies` snapshot. A same-key replay compares only this intent hash:
  matching intent returns the original frozen view exactly, even if server-side
  dependencies have since drifted (a new inbound, a policy/sender/context/contact-name
  revision) — that drift is the not-yet-written accept/claim recheck's job, never
  freeze replay's. A replay with different targets or a different template raises
  `INBOX_REPLY_IDEMPOTENCY_MISMATCH`. `canonical_input` still stores the full
  first-successful raw payload for audit/debugging only; it is never read by the
  replay gate.
- Recomputes time-only exclusions (window expiry, quiet hours) at freeze time using
  only the database clock, after all lock waits.
- Flags every conversation sharing a destination phone as `duplicateDestination` —
  never silently drops or picks one.
- Sets `expires_at = freeze_time + 5 minutes` (capped further by the earliest
  still-eligible recipient's own window), matching Fable's ruling that freeze
  validity is 5 minutes, not the spec's 15.
- Surfaces `blockers`: `empty` (zero eligible recipients), `recipient_limit`
  (more than `inbox_reply_preparation.recipient_limit()` distinct eligible
  destinations — same D5 single-source-of-truth function `inbox-reply-preparation`
  uses, not a repeated literal), `duplicate_destination`.

`public-api.sql` wires `public.inbox_capture_reply_recipients(conversation_ids uuid[])`
and `public.inbox_freeze_reply_review(canonical_input text, idempotency_key uuid)` as
`SECURITY DEFINER`, default-closed via `require_admission()`, granted only to
`authenticated`, never `anon`/`service_role`. Each wrapper sets its own
`lock_timeout`/`statement_timeout` (3s/15s) rather than trusting the calling role's
session GUCs, since a `SECURITY DEFINER` function runs as `postgres` regardless of
what the authenticated caller's own session has configured.

## Status of the proofs in this directory

`run.py` (rollback-only, single connection) **has been re-run** against the marked
owned fixture (`sandra-inbox-projection-t2-db`, marker
`sandra-inbox-projection-t2-owned-synthetic`) as part of this pass — twelve groups
pass, including new coverage for: the fail-closed line-type/consent semantics living
in `inbox-reply-preparation` flowing through capture correctly, the intent-hash
idempotency behavior under real dependency drift, and the freeze-level
`recipient_limit`/`duplicate_destination` blockers. All three new/changed behaviors
were mutation-checked by hand — temporarily reverting each fix (the intent-hash
formula, the `recipient_limit` blocker condition, the `duplicate_destination`
blocker condition) and confirming the corresponding assertion in `run.py` actually
fails, before restoring. `review-evidence.json` is regenerated from that run.

`replay-concurrency.py` (two real connections, verifies an in-flight freeze against
a request-key lock actually waits, then denies without leaking the frozen body once
the actor's access expires mid-wait) was **not** re-run — it was recovered from an
unpublished handoff copy, was never previously committed, and `DROP SCHEMA ...
CASCADE`s on `inbox_reply_review`/`inbox_reply_preparation`/`inbox_reply_context` as
part of its own cleanup, which is unsafe against this shared, already-drifted
fixture while other concurrent sessions depend on it. Re-run it only against a
freshly-rebuilt isolated fixture (Lane-2). There is no `verify.py` in this directory
yet (unlike `inbox-reply-preparation`); source hashes are recorded in
`review-evidence.json` but nothing currently checks them in CI.

Remaining gates: cap enforcement/duplicate resolution at acceptance (a separate,
not-yet-written `accept()`); current actor/dependency/time rechecks at dispatch;
committed dispatch marker and account admission; receipt persistence and verified
callback reconciliation; review UI. No production schema, flags, credentials, or
provider calls are changed by these files.
