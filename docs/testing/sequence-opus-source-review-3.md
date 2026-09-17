# Opus source review 3

Session: 0a90fcc3-520c-4499-bfa1-2a0bd908bf64

# Opus source review 3 — corrections + scheduler delta

Reviewed against the supplied snapshot text only. Hash pinning is root's.

## Prior blockers — traced and closed

**B1 (stale reconciliation returned two rows) — fixed.** `retire_stale_sequence_claim` now reads `return query select 'reconciliation_required'; return;` inside the inner `if`, so the fall-through to `'active'` is gone. The contract is now one row on every path. Regression is present and asserts the shape, not just the head: `expect(stale.data).toEqual([{ outcome: "reconciliation_required" }])`. The redundant `e.id is not null and … attempt_outcome in (…)` conditions remain; harmless.

**B2 (consent fence tie-break) — fixed, on one stated premise.** The order is now `occurred_at desc, (event_type in ('opt_out','provider_auto_opt_out')) desc, id desc`. The boolean key is non-null by construction (the `IN` filter above it excludes NULL `event_type`), and `DESC` puts `true` first, so a tied opt-in/opt-out resolves to suppression rather than a UUID coin flip. `nulls last` is omitted on `occurred_at`; that is correct **only** because root pins `consent_events.occurred_at` as `NOT NULL` in migration 007. That premise is not verifiable from this snapshot, so it stays on the evidence list below — not as a blocker, but as the one assertion holding up the NULL half. Tied-timestamp regression is present and asserts `definitively_rejected` + `'contact has opted out of SMS'`.

**B3 (cancel had no claim-linked, in-transaction audit) — fixed.** `cancel_sequence_enrollment` is a `security definer` RPC holding `select … for update` on the enrollment across the claim stamp, the enrollment terminal write, and the `lead_events` append. Specifically:

- **Auth/tenant**: same shape as retry/resume — service-role must omit an actor; an authenticated caller must have `auth.uid()`, must not supply a mismatched actor, and must hold a `memberships` row on `e.org_id`. Cross-tenant returns `not_authorized` with no writes; the regression asserts the claim is untouched afterward.
- **Actor attribution**: `resolved_actor := coalesce(p_actor_user_id, auth.uid())` for non-service-role, so omitting the parameter still records the authenticated identity. `actor_type` follows (`user`/`system`).
- **Claim fence preserved**: `retained_claim := r.claim_active`, and since `r` is selected `where sr.claim_active`, the `case when retained_claim then sr.claim_active else false end` can only ever write `true`. Cancel therefore cannot release a fence under any input. The `else false` arm is unreachable — confusing, not wrong.
- **Event payload** carries `claim_id`, `message_id`, `attempt_outcome`, `failure_reason`, `claim_active`, `recovery_action`, `recovery_evidence`; the claim itself carries `recovery_actor_user_id`/`recovery_action='cancel'`/`recovery_evidence`.
- **Atomicity**: a failing `lead_events` insert aborts the whole function, reverting both the claim stamp and the enrollment write. The regression forces that via a conflicting `(source_type, source_id)` row and asserts `status='active'` + a pristine claim.

Two PL/pgSQL hazards I specifically checked, since the OUT parameter is named `claim_active`, identical to a column on the table being written: the only unqualified uses are an `UPDATE … SET` target (exempt from variable resolution), an `INSERT … VALUES` expression (no range table, so it binds the variable), and a `RETURN QUERY SELECT` with no `FROM`. No ambiguity error is reachable. Lock ordering (enrollment → claim) matches `authorize`, `retry`, `resume`, and `retire_stale`, so cancel introduces no deadlock cycle.

**B4 — fixed.** The `processEnrollmentTick` header now reads "retire the claim only through a proof-gated update," matching the guarded `claim_active=false` write.

**Root-found omission — fixed.** `retry_sequence_step` and `resume_sequence_enrollment` both stamp `recovery_actor_user_id = coalesce(p_actor_user_id, auth.uid())`; the regression exercises both under a real member JWT and asserts `user.userId`.

## Scheduler delta (head-of-line starvation) — reviewed

The defect is real and correctly diagnosed: `skipped_already_claimed` rows stay `active` and due, so a full page of retained claims re-selects every tick and the 101st enrollment never runs. The dominant generator is the four no-pause sites (non-gating §1 below) — one deleted template shared across a hundred enrollments produces exactly this page.

What the delta actually does, and what I verified:

- Ordering is now a stable keyset (`next_run_at asc, id asc`) with an `.or(next_run_at.gt.X, and(next_run_at.eq.X, id.gt.Y))` cursor. Timestamp values carry `+`, which `URLSearchParams` percent-encodes, and fractional-second dots land after PostgREST's column/operator split, so the filter is well-formed.
- A second page is fetched **only** when the first page returned exactly `BATCH_SIZE` rows and every one was `skipped_already_claimed`. Lookahead is capped at `RETAINED_CLAIM_LOOKAHEAD_ROWS = 100` and stops on the first independent outcome. Because `lookaheadRows` increments on every lookahead row, paging is bounded at two fetches — I could not construct an unbounded-paging path.
- **No double-processing.** The only way a row advanced in-tick could be re-selected is if its new `next_run_at` still satisfies `lte(nowIso)` and sorts after the cursor. But an advanced row is not `skipped_already_claimed`, which clears `pageAllRetained` and breaks before any further fetch; on a lookahead page an independent outcome stops the scan immediately. So no enrollment can fire two steps in one tick.
- Budget guard still dominates: `withinBudget()` is checked per row and before the extra fetch, and sets `budgetExhausted`.
- `processed`/`outcomes` can now exceed 100 (≤200). Return type unchanged; callers tally only.

Effect, stated without embellishment: once a full retained page exists, exactly **one** independent enrollment clears per tick until the retained claims age past the 15-minute stale window and reconciliation retires or pauses them. Root's framing — bounded mitigation, no fairness guarantee, larger backlogs wait for stale reconciliation — is the accurate description. I found no correctness defect in the delta.

## Non-gating (carried forward)

1. **The four no-pause sites remain the starvation generator** (template fetch error, `change_status` error, non-DNC `!changedProperty`, unsupported `action_type`). They leave the enrollment active+due with an active claim, and the stale sweep is only reachable from the tick's 23505 path — which does clear them, but only after 15 minutes of occupying due slots. `pauseEnrollment(…, "provider_failed", false)` at those four sites removes the generator entirely and is strictly cheaper than the lookahead it now depends on. Recommended before rollout; not a gate, and not a new requirement — it is the same fix from review 2.
2. **Accepted claims are never deactivated on success**, so `listPropertyEnrollments`'s "newest active claim" stays a heuristic; scoping it to the enrollment's current step would make it correct by construction. The `sent` branch is still the only claim write with no outcome guard.
3. **`unknown`/`not_attempted` claim under a benign pause reason**: `pauseEnrollment`'s `.eq("status","active")` means `pause_reason` is not upgraded, and a paused enrollment is never re-selected, so its claim never reaches the stale sweep. The widget then renders the reconcile banner with `claim unavailable` or a `not_attempted` outcome the operator cannot retry. Cancel is available, so the no-stall clause holds; the display is the conservative direction.
4. `retrySequenceStep`'s `not_authorized` branch is still dead (RPC returns `reconciliation_required`); `resumeByProperty` still under-reports skipped rows; the index assertion is still key-order-sensitive; `failStalePendingProviderAttempts` still runs without a `withinBudget()` check; `cancel_sequence_enrollment` distinguishes `not_found` from `not_authorized` (negligible existence oracle, same as retry/resume); the `else false` arm in the cancel claim update is unreachable.
5. Standing and unchanged: archiving is not a stop control; no cross-sequence per-contact cooldown; webhook secret still accepted in the query string (constant-time compared).

## Required in the pending evidence (unchanged plus cancel)

- **Trigger-owner invariant, now covering three authenticated paths.** `guard_sequence_step_run_runtime_write` passes for `retry`/`resume`/**`cancel`** only because `SECURITY DEFINER` sets `current_user` to the migration owner. Exercise all three under a real `authenticated` JWT against the deployed owner; a different owner is a total send outage, not a partial one. Confirm `auth.role()` resolves in the target database.
- Confirm `consent_events.occurred_at` is `NOT NULL` (B2's omitted `nulls last` rests entirely on this).
- Confirm the `lead_events` uniqueness the cancel-rollback regression depends on actually exists in the target schema — otherwise that test passes vacuously and the atomicity claim is unproven.
- B1's single-row assertion; `sms_phone_suppressions` has no soft-delete column; re-run the P0-1 legacy inventory preflight against the final candidate.
- The DB run's 8 failures and the corrected browser fixture must be re-run to green; the 4612/1511 unit/RTL pass predates this delta and does not cover it.

---

**SOURCE REVIEW APPROVED.** B1–B4 are resolved as described, the retry/resume actor omission is closed, and the scheduler delta is correct, bounded, and free of double-processing within the interleavings I traced. The send fence, retirement proofs, monotonic outcome ladder, and cancel's fence retention all hold. This is code-review-only on the supplied snapshot and is contingent on the full real-database, browser, and mutation evidence above completing green; pending evidence is not treated as green here. It is **not** deployment, live-send, or canary authorization. A candidate whose hashes differ from those pinned requires re-review.
