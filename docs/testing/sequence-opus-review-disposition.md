# Opus disputed finding disposition

Session: cef4286b-b245-405e-990c-51279deceb2c

# Disputed-finding disposition

All five of your points are argued from evidence I did not have (old-code `run_at` semantics on `provider_failed`, the exact original index name/DB manifest, and the revision-3 characterization scope). Three of my findings contained real errors. Dispositions below.

| # | Finding | Disposition | Rationale |
|---|---|---|---|
| P0-1a | Blanket `claim_active = false where run_at is not null` | **Withdraw** | You are right and my snippet was unsafe. `run_at` is not proof of non-send, and clearing the fence on a row whose enrollment never advanced re-permits a claim insert at the same step. That is the exact duplicate-send path my own P0-4 describes; my backfill would have manufactured it at scale. |
| P0-1a | `skipped_reason is not null → 'definitively_rejected'` | **Withdraw** | Decisive: old code stamps `run_at` + `skipped_reason='provider_failed'` *after* an ambiguous submission. My mapping converted ambiguous sends into the one state that authorizes resend. This was the most dangerous line in my review. |
| P0-1b | `alter column attempt_outcome set default 'not_attempted'` | **Withdraw** | `not_attempted` is a proof token in this design; a column default cannot manufacture proof for a worker that never recorded intent. Quiescing old workers is the correct control. Retaining `unknown` + active for legacy claims is right. |
| P0-1 | Operational harm at cutover (legacy current-step rows drive reconciliation, not benign skips) | **Retain, reframed as a rollout gate** | The harm is real but the remedy is preflight inventory + quiescing + a visible actionable state, not relabeling data. See narrow alternative below. |
| P0-1c | Column-level revoke on fence columns in *this* migration | **Resolved** by your authenticated claim-write guard (point 5), pending live verification. |
| P0-2 | DO block dropping all unconditional unique indexes | **Withdraw implementation** | Correct — `indisunique and indpred is null` matches `sequence_step_runs_pkey`. The snippet would drop the primary key. Unusable as written. |
| P0-2 | Requirement that the index change cannot silently no-op | **Retain, narrowed** | `drop index if exists` on an exact name is fine given the verified manifest; the residual requirement is a post-condition assertion, not a broad drop. Precise invariant below. |
| P0-4 | `resolve_sequence_reconciliation(..., 'delivered' \| 'not_delivered', ...)` | **Revise** | The `not_delivered` arm is an operator guess authorizing a send — it violates "ambiguous/accepted attempts must never be blindly resent" and "do not implement a new recovery policy." Withdrawn. The `delivered` arm is also mis-specified: it should be evidence-gated, never operator-asserted. |
| P0-4 | Requirement that `reconciliation_required` have an in-product exit | **Retain** | Still required by the no-stall clause ("paused-**actionable**"). Your cancellation path satisfies it; raw SQL alone does not. Minimum spec below. |
| P2-19 | Add `and seq.active and seq.archived_at is null` to the RPC | **Withdraw as a change request; retain as a characterization finding** | Revision 3 fixes these semantics as characterization-only. Prescribing a change is out of scope. The operator-expectation gap (archiving is not a stop control) should be recorded as a proposed-fix finding and documented in operator-facing text; it must not gate. |
| P2-30 | Cross-sequence per-contact cooldown | **Withdraw as gating; retain as documented decision** | I already flagged it as probably intentional. Out of scope; record it as explicit, not emergent. |
| P2-26 | Ceiling on `attempt_count` | **Revise** | Your distinction holds: capping explicit human retries is invented policy. Residual ask is observability only — `attempt_count` visible on the reconciliation surface so runaway manual retry is noticeable. Non-gating. |
| P2-29 | Webhook secret in query string | **Retain as out-of-scope standing finding** | I labeled it out of scope originally and am not asking for removal or an integration break. Leave the parameter accepted; the only in-scope-adjacent asks are constant-time comparison and log redaction, and both can be deferred to a separate ticket. Does not gate. |

Undisputed and still open: **P0-3** (dead-end `'active'` branch for `definitively_rejected` / `not_attempted`-with-`run_at`, plus the three `markRunSkipped`-then-`failed` sites with no pause), **P0-5** (RPC-level `provider_failed` guard, since the TS check is bypassable), **P0-6** (`coalesce(e.pause_reason,'')`), **P1-7** (suppression normalization asymmetry — compliance fence), **P1-8** (blanket 4xx → `definitiveRejection`), **P1-9** (abort timer cleared before body read), **P1-10** (unguarded quiet-hours DELETE, two unchecked writes), **P1-11** through **P1-13**. P0-3 and P1-7/P1-8 are the ones I would hold hardest.

## Narrow safe alternative to P0-1

Not a backfill of ambiguous rows. Preflight facts + one optional evidence-based subset:

1. **Inventory, gate on the numbers** (required): count legacy rows at each enrollment's `current_step_index` grouped by `skipped_reason`, `message_id is not null`, `run_at is null`. This is the predicted reconciliation volume at cutover. If it is large, that is a rollout decision, not a surprise.
2. **Quiescing proof** (required): no writer without intent-recording may be able to insert a claim after the migration applies. Assert deployment ordering explicitly rather than relying on a default.
3. **Optional, provable subset only**: rows with `skipped_reason in ('quiet_hours','consent_revoked','paused','escalated','no_phone')` are pre-provider by construction in the old code and may be retired as proven non-sends. `provider_failed` is excluded unconditionally. Do this only if step 1 shows the volume justifies it; `unknown` + reconciliation is the conservative-correct default, and I no longer recommend touching these rows.

## P0-2 precise invariant

Assert the shape, keep the PK, fail on drift:

```sql
-- no unconditional unique index/constraint on exactly (enrollment_id, step_id)
if exists (
  select 1 from pg_index x join pg_class t on t.oid = x.indrelid
   where t.relname = 'sequence_step_runs' and x.indisunique and x.indpred is null
     and x.indkey::int2[] @> array(select attnum from pg_attribute
           where attrelid = t.oid and attname in ('enrollment_id','step_id'))::int2[]
) then raise exception 'unconditional (enrollment_id, step_id) unique index survived migration'; end if;
-- and the partial index exists
if not exists (select 1 from pg_class where relname = 'idx_step_runs_active_enrollment_step')
  then raise exception 'partial claim index missing'; end if;
```

Key-set scoped, so the PK is untouched. Table-lock sizing note for the non-`CONCURRENTLY` build stands as operational, non-gating.

## P0-4: exact minimum required, no guessed non-delivery

Acceptable to the approved contract. Minimum:

1. **Durable, visible, specific state**: `reconciliation_required` plus the claim id, step index, `attempt_outcome`, and `failure_reason` surfaced in-product — not a bare "paused."
2. **One non-SQL operator action that reaches terminal without any send**: cancel/terminate the enrollment. This alone satisfies "paused-actionable." Required.
3. **`unknown`**: no advance, no re-arm, no resend, ever, by any parameter. Cancel or remain paused. No `not_delivered` input exists.
4. **`accepted` advance (optional extension)**: permitted only if gated inside the transaction on joint evidence — `attempt_outcome = 'accepted'` **and** a linked `messages` row with a provider external id. No operator-asserted delivery parameter. Additionally it must (a) re-run the stop/consent/suppression authorization before re-activating, since it re-arms future steps, and (b) compare-and-set `current_step_index` to the expected value so concurrent operator actions cannot double-advance.
5. **Audit inside the transaction**: actor, claim id, and the evidence basis, written in the same transaction as the state change — not as a follow-up TS lead event.

Item 4 is a product change, not harness work. If it lands, it belongs in the candidate branch with its own review; per revision 3 the test-side output for a missing recovery operation is an unmet-contract failure plus a proposed-fix finding.

Separately, the *generator* of these states is worth recording: post-send advancement missing on the inbound-reply race leaves an `accepted` claim active at the current step. Retiring that claim on the sent-but-stopped path is only safe if the tick treats "accepted row at current step" as already-fired rather than re-claiming it — so it is coupled to P2-25 and is an optional extension, not a gate.

## Readiness gates vs. optional extensions

**Gates** (block trusting runtime results): P0-2 assertion; P0-3 dead end + the three no-pause sites; P0-5; P0-6; P1-7; P1-8; P1-10; P0-4 items 1–3 and 5; P0-1 rollout items 1–2.

**Optional policy extensions** (explicitly out of the gate): P0-4 item 4; P0-1 item 3; P2-19; P2-25; P2-26 observability; P2-30; P2-29.

## On point 5

Acknowledged, pending live confirmation on the tested SHA. One caution: "crash fixture incorrect `message_id` expectation being corrected" is the precise shape of the triage trap I flagged. A crash before the `messages` insert should have no `message_id`; a crash after provider acceptance should have one. Please state which boundary the fixture injects and derive the expectation from that boundary, rather than from observed output — otherwise the correction can mask a real post-send persistence gap.

No implementation or deployment approval is granted here. This is scope adjudication only; the retained findings above still require confirmation against the live database.