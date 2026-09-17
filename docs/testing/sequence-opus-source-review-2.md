# Opus source review 2

Session: 064458e9-ea32-4677-8876-1eaa5057527c

# Independent source review — Sandra sequence runtime (snapshot as supplied)

Reviewed against the supplied text only. I did not inspect the working tree; hash verification is root's.

## Claimed fixes I traced and confirm

- **Index postcondition (P0-2)** — `drop index if exists` on the exact name plus a DO block that (a) raises if any unconditional unique index whose key list is exactly `{enrollment_id, step_id}` survives and (b) raises if `idx_step_runs_active_enrollment_step` is missing/not-partial/wrong predicate. PK is untouched (its key set is `{id}`). If the legacy index were a *constraint*, `drop index` errors loudly rather than silently no-opping. Correct.
- **P0-3 dead end** — `retire_stale_sequence_claim` now retires `definitively_rejected` and `not_attempted` (both `run_at` shapes) and pauses `provider_failed`, which is the state the UI offers **Retry** from. The four `markRunSkipped`-then-`failed` sites that still don't pause are no longer terminal: the claim keeps `run_at`, the enrollment stays due, and the ≤15-minute stale sweep retires it and pauses. Exit exists. (See non-gating §1.)
- **P0-5 / P0-6** — `retry_sequence_step` enforces `status='paused' and pause_reason is not distinct from 'provider_failed'` *and* `prior.attempt_outcome in ('not_attempted','definitively_rejected')` inside the RPC; `resume_sequence_enrollment` uses `coalesce(e.pause_reason,'')`. Both fixed.
- **Monotonic claim writes** — `markRunSkipped`'s `allowedCurrentOutcomes` gate is the load-bearing defense. I stress-tested it: even if `authorize_sequence_provider_attempt` committed `unknown` and the client lost the reply, the TS fallback `attemptOutcome: "not_attempted"` cannot land, because the update requires `attempt_outcome in ('not_attempted')`. It falls to `failAfterRunWrite` → `reconciliation_required`. Defense in depth holds.
- **Retirement safety (the core invariant)** — every path that sets `claim_active=false` (`retry_sequence_step`, `retire_stale_sequence_claim`, `resume_sequence_enrollment`, quiet-hours) is proof-gated on `not_attempted`/`definitively_rejected` *and* serialized by `select … from sequence_enrollments … for update`, which `authorize_sequence_provider_attempt` also takes first. The TOCTOU I went looking for in `retry_sequence_step` (its `prior` select has no `FOR UPDATE`, and its retirement `UPDATE` is guarded only on `claim_active`) is closed by that enrollment lock: `authorize` cannot commit `unknown` while retry holds it. **I found no reachable duplicate-send path.**
- **`db_error` classification** — every `db_error` return in `sendSmsToContact` that can occur after provider acceptance sets `deliveryOutcome` explicitly; the `?? (externalId ? "accepted" : "not_attempted")` fallback is only reached on pre-provider returns. `releaseQueuedMessage` lacks the same field but is unreachable for sequence sends (`sequenceContext` is never set on a queued row).
- **Sendillo** — timeout now spans `response.text()` inside the same `try` with `clearTimeout` in `finally`; 400-only `definitiveRejection`; 5xx→ambiguous; other 4xx, transport, mid-flight abort, and 2xx-without-id all map to `unknown`; pre-flight aborted signal is the only `notSent`. `constantTimeEqual` in place. Consistent with `classifySequenceProviderFailure`.
- **Crash-fixture `message_id` boundary** — derivable from source, not from output: `authorize_sequence_provider_attempt` writes `message_id = p_message_id` in the *intent* update, before returning true, and `send.ts` calls the provider only after. So any crash at or after authorization must show a non-null `message_id` pointing at a `pending` messages row. The corrected "pending link" expectation is the one the code implies. This is not the triage trap I warned about.
- **STOP boundary** — permanent pause uses `.in("status",["active","paused"])` in both `pausePropertyEnrollments` and `pauseContactEnrollments`, so a STOP retires already-paused enrollments to `opted_out`. Claim state is irrelevant to the stop, which is correct.
- **Cancel as terminal exit** — `cancelEnrollment` leaves the claim active; a later re-enrollment gets a new `enrollment_id`, so the partial index cannot collide. Cancel is a genuine no-send terminal (P0-4 item 2 met).

## Blockers

**B1 — `retire_stale_sequence_claim` returns two rows on the reconciliation path.** `return query` does not exit a PL/pgSQL function. In:

```sql
if r.attempt_outcome = 'unknown' or r.attempt_outcome = 'accepted' then
  if e.id is not null and e.status = 'active' and ... then
    update public.sequence_enrollments ... ;
    return query select 'reconciliation_required';
  end if;            -- <-- no `return;`
  return query select 'active';
  return;
end if;
```

the reconciliation branch appends `'reconciliation_required'` **and then falls through** to append `'active'`. Every other branch in this file pairs `return query` with `return;`; this one omits it. `tick.ts` reads `staleResult?.[0]?.outcome`, so today's behavior is accidentally correct, but the RPC's contract is violated, and any database test asserting a single row — or any future caller reading the last row / using `.single()` — gets the wrong verdict on the single most safety-relevant outcome in the runtime. Fix: add `return;` after the `reconciliation_required` return query. (The `e.id is not null` and repeated `attempt_outcome in (...)` conditions in that inner `if` are already guaranteed and can go.)

**B2 — consent fence can fail open on NULL/tied `occurred_at`.** In `authorize_sequence_provider_attempt`:

```sql
order by ce.occurred_at desc, ce.id desc limit 1
```

`DESC` in Postgres is `NULLS FIRST`. A `consent_events` row with a NULL `occurred_at` — an opt-in, a backfilled import, a provider event persisted without a timestamp — sorts ahead of a real later `opt_out` and becomes `latest_consent`, and the RPC authorizes the send. Separately, an `opt_in_*` and an `opt_out` sharing an exact `occurred_at` are resolved by UUID, i.e. by coin flip, in the direction of sending. This is the last compliance fence before the provider call and it must break toward suppression:

```sql
order by ce.occurred_at desc nulls last,
         case when ce.event_type in ('opt_out','provider_auto_opt_out') then 0 else 1 end,
         ce.id desc
```

If `consent_events.occurred_at` is `NOT NULL` in the manifest, the NULL half is moot and only the tie-break clause is required — state which, rather than leaving it to ordering defaults.

**B3 — cancel-during-reconciliation has no claim-linked audit (P0-4 item 5, previously retained as a gate).** `cancelEnrollment` in `sequences/actions.ts` performs the terminal state change via PostgREST and then records a `SEQUENCE_CANCELED` lead event whose payload is `{enrollment_id, sequence_id}` — no claim id, no `attempt_outcome`, no evidence basis, and not in the same transaction as the state change. The DB recovery RPCs do write `recovery_actor_user_id` / `recovery_action` / `recovery_evidence` in-transaction; the one operator action that resolves `reconciliation_required` does not. Minimum: include the active claim's `id`, `attempt_outcome`, `failure_reason`, and `message_id` in the cancel event payload. Complete fix, and the only one that satisfies the retained wording: move cancel behind a `security definer` RPC that stamps `recovery_action='canceled_unreconciled'` plus actor and evidence onto the active claim in the same transaction as the enrollment update — note that the new write trigger now makes the direct authenticated write impossible anyway, so an RPC is the only route.

**B4 (documentation, trivial, but in the wrong file to leave wrong).** The `processEnrollmentTick` header still reads *"`blocked_quiet_hours` → reschedule +N hours, **DELETE the claim** so the next tick can re-fire."* The code no longer deletes; it flips `claim_active=false` guarded on `claim_active AND attempt_outcome='not_attempted'`, which is precisely the P1-10 fix. Leaving the instruction in the file's contract comment invites reintroduction of the unguarded DELETE. Correct the comment.

## Non-gating (characterization / proposed fix)

1. **15-minute busy-spin at the four no-pause sites** (template fetch error, `change_status` error, non-DNC `!changedProperty`, unsupported `action_type`). The enrollment stays `active` and due, is re-selected every tick, and burns a step load + property load + failed insert + claim select + RPC per pass until the stale sweep retires it. Safe, visible, self-healing; cheap fix is `pauseEnrollment(..., "provider_failed", false)` at those four sites. Non-gating.
2. **Accepted claims are never deactivated on success.** The `sent`/`queued` branch writes `attempt_outcome='accepted'` without `claim_active=false`, so every completed step leaves an active claim. Harmless for the fence (the index is per `step_id`) and better for audit, but it makes `listPropertyEnrollments`'s "newest active claim per enrollment" an unbounded scan and a heuristic rather than a scoped lookup. It happens to be correct today — every `reconciliation_required` pause is raised in a context where the current step's claim exists and is newest — but scoping that query to the enrollment's current step would make it correct by construction. Also, that `sent` update is the only claim write with no outcome guard; `.in("attempt_outcome",["unknown","accepted"])` would make it symmetric with `markRunSkipped` at no cost.
3. **Unknown claim under a benign pause reason.** If an enrollment is already paused (e.g. `inbound_reply`) when an `unknown` claim lands, `pauseEnrollment`'s `.eq("status","active")` guard means `pause_reason` is never upgraded to `reconciliation_required`, so the widget renders **Resume** rather than the claim/outcome banner. Resume fails safe (the RPC returns `reconciliation_required`, surfaced as an error toast) and Cancel works, so the no-stall clause is met — but P0-4 item 1's "specific, in-product state" is met only for the `reconciliation_required` variant.
4. **`retrySequenceStep`'s `not_authorized` branch is dead** — the RPC returns `reconciliation_required` on authorization failure, so a non-member sees "cannot be retried safely until delivery is reconciled" instead of an auth error. Fail-safe, misleading.
5. **`resumeByProperty`** silently skips enrollments whose RPC returns `reconciliation_required`; the returned `resumed` count under-reports with no explanation to the caller.
6. **Index assertion is order-sensitive** (`array_agg(...) = array['enrollment_id','step_id']`), so a hypothetical unconditional unique index on `(step_id, enrollment_id)` would pass the assertion while defeating the design. Key-set containment would close it; not worth gating given the verified manifest.
7. **`failStalePendingProviderAttempts`** runs after the enrollment loop without a `withinBudget()` check, up to 240 rows × 2 round-trips. Operational only.
8. **Standing, unchanged, non-gating:** archiving is not a stop control (the tick and the RPC check org/existence, not `seq.active`/`archived_at`); no cross-sequence per-contact cooldown; webhook secret still accepted in the query string (now constant-time compared; redaction deferred); `attempt_count` not surfaced; non-US numbers are rejected at the RPC phone fence by construction.

## Required in the pending database run

- **Trigger-owner invariant.** `guard_sequence_step_run_runtime_write` admits a write only if `auth.role()='service_role'` **or** `current_user in ('postgres','supabase_admin','service_role')`. The authenticated-user retry/resume paths pass only because `SECURITY DEFINER` sets `current_user` to the function owner. Exercise `retry_sequence_step` and `resume_sequence_enrollment` end-to-end under a real `authenticated` JWT on the deployed migration owner; a different owner turns this into a total sequence-send outage (every `authorize` → 42501 → `unknown` → `reconciliation_required`), not a partial one. Also confirm `auth.role()` resolves in whatever database the tests run against.
- Assert `retire_stale_sequence_claim` returns **exactly one** row on the reconciliation path (this is B1's regression test).
- Confirm `consent_events.occurred_at` nullability and re-run the opt-out race with a tied timestamp (B2).
- Confirm `sms_phone_suppressions` has no soft-delete/inactive column that would make presence-implies-suppressed wrong in the un-suppress direction.
- Re-run the P0-1 rollout preflight (legacy current-step inventory by `skipped_reason` / `message_id` / `run_at`, and writer-quiescing ordering) against the final candidate.

---

**CHANGES REQUIRED** — B1, B2, B3 substantive, B4 documentation. None of them is a duplicate-send path; the send fence, the retirement proofs, and the monotonic outcome ladder all hold under the interleavings I traced. This disposition is code-review-only on the supplied snapshot, contingent on the pending database/browser/mutation evidence, and is not deployment or live-delivery approval. A final candidate whose hashes differ from those pinned above requires re-review.
