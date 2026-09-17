# Opus 5 preliminary source review

Session: f7b3ec94-5722-4541-806e-570e4e6a2942

# Source Review — Sandra Sequence Reliability (WIP snapshot)

Reviewed: `20260917110000_sequence_runtime_recovery.sql`, `src/lib/sequences/tick.ts`, `src/lib/sequences/enrollment.ts`, `src/lib/messaging/send.ts`, `src/lib/messaging/providers/sendillo.ts`. No tool access; findings derive from the snapshot text only. The three known in-flight fixes (post-provider `db_error`, `markRunSkipped` ambiguity preservation, authenticated audit-field mutation) are not re-listed as findings — where I have materially new detail on them it is called out as such and marked.

The fence design is sound in its core: enrollment lock → claim lock → joint recheck → intent write → immediate provider call, with `unknown` as the default post-authorization state. The defects below are almost all in the *recovery and rollout* surface around that core, not the core itself.

---

## P0 — Must fix before runtime tests mean anything

### 1. Migration backfill marks every historical run row as a live claim, and the column default is wrong for new inserts

`supabase/migrations/20260917110000_sequence_runtime_recovery.sql`, the `alter table ... add column` block.

```sql
add column if not exists claim_active boolean not null default true,
add column if not exists attempt_outcome text not null default 'unknown',
```

Two distinct problems share this statement:

**(a) Existing rows.** `sequence_step_runs` is a historical audit table — every step that ever fired has a row. This backfill declares all of them `claim_active = true, attempt_outcome = 'unknown'`. The partial unique index will still build (the old unconditional index guaranteed at most one row per pair), so the migration *succeeds silently* and the damage only appears at runtime:

- Any paused enrollment whose `current_step_index` still has a run row now fails `resume_sequence_enrollment` (`r.attempt_outcome not in ('not_attempted','definitively_rejected')` → `reconciliation_required`), and `retry_sequence_step` refuses it too (`e.pause_reason <> 'provider_failed'`). **Zero recovery paths.** Every such enrollment is permanently dead on the first post-migration operator action.
- Any *active* legacy enrollment that re-ticks a step with an existing run row: `claimErr 23505` → `retire_stale_sequence_claim` → `created_at` is ancient so it is stale → `attempt_outcome in ('unknown','accepted')` → the enrollment is force-paused `reconciliation_required`. Pre-migration this same situation produced a benign `skipped_already_claimed`; post-migration it is an irreversible pause.

The backfill must be evidence-based, not blanket-conservative, because "unknown" is not a safe default when the row is *provably* historical:

```sql
-- after adding the columns with a permissive default
update public.sequence_step_runs
   set claim_active = false,
       attempt_outcome = case
         when skipped_reason is not null then 'definitively_rejected'
         when message_id is not null and run_at is not null then 'accepted'
         else 'unknown'
       end
 where run_at is not null;          -- terminal, already reconciled by the old code
-- rows with run_at is null are the only genuinely in-flight claims: leave
-- claim_active = true, attempt_outcome = 'unknown'.
```
Then verify the residual set is small enough to hand-reconcile before cutover (`select count(*) from sequence_step_runs where claim_active and run_at is null`).

**(b) Future rows.** `default 'unknown'` applies to *every* subsequent insert that does not name the column. `tick.ts` names it explicitly, but during a rolling deploy the **old app instances do not** — they insert claims defaulting to `'unknown'` and never call `authorize_sequence_provider_attempt`. A new instance's `retire_stale_sequence_claim` sees `'unknown'` and force-pauses `reconciliation_required`. Expect one trapdoored enrollment per in-flight tick per deploy, forever, not just at cutover. Fix: after the backfill, `alter table public.sequence_step_runs alter column attempt_outcome set default 'not_attempted';`.

**(c) Sub-point on the known audit-field fix, specific to this migration.** `claim_active` is *the fence column*, and the migration adds it with no column-level revoke, no trigger, and no mention of amending existing `sequence_step_runs` policies. Whatever shape the audit-field fix takes, it needs `revoke update (claim_active, attempt_outcome, run_at, message_id, attempt_started_at, attempt_count) on public.sequence_step_runs from authenticated, anon;` in *this* migration, not a follow-up — otherwise the migration ships a window where any org member can clear the duplicate-send fence with a PostgREST PATCH.

### 2. `drop index if exists` silently no-ops on a name mismatch, and the failure mode is an unrecoverable tick loop

Same file:

```sql
drop index if exists public.idx_step_runs_unique_enrollment_step;
create unique index if not exists idx_step_runs_active_enrollment_step ...
```

If the old index is actually named something else, or is backed by a `UNIQUE` **constraint**, the `if exists` swallows it and the unconditional unique index survives alongside the partial one. Consequence: after any claim is retired (`claim_active = false`), the next tick's `INSERT` still hits `23505` against the *surviving* index, the `23505` handler then queries `.eq("claim_active", true)` and finds nothing, and `tick.ts` returns `failed: "active sequence claim disappeared"` — with **no pause**, so the cron retries it every cycle indefinitely. A silent migration no-op becomes a permanent, alarm-free hot loop.

Replace with an assertion that cannot be satisfied by doing nothing:

```sql
do $$
declare idx record;
begin
  for idx in
    select i.relname
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
     where t.relname = 'sequence_step_runs' and x.indisunique and x.indpred is null
  loop
    execute format('alter table public.sequence_step_runs drop constraint if exists %I', idx.relname);
    execute format('drop index if exists public.%I', idx.relname);
  end loop;
  if exists (select 1 from pg_index x join pg_class t on t.oid = x.indrelid
              where t.relname = 'sequence_step_runs' and x.indisunique and x.indpred is null) then
    raise exception 'unconditional unique index on sequence_step_runs survived migration';
  end if;
end $$;
```

Also note the `create unique index` is not `CONCURRENTLY` — it takes a table lock for the build duration. Size `sequence_step_runs` before applying in production.

### 3. `retire_stale_sequence_claim` has a dead-end branch that permanently stalls an enrollment that still reads `status = 'active'`

Migration, `retire_stale_sequence_claim`:

```sql
if r.attempt_outcome <> 'not_attempted' or r.run_at is not null then
  if e.status = 'active' and r.attempt_outcome in ('unknown','accepted') then
    ... pause reconciliation_required ...
  end if;
  return query select 'active';   -- <-- dead end
  return;
end if;
```

A stale claim that is `definitively_rejected`, or `not_attempted` **with `run_at` set**, falls through to `'active'`. `tick.ts` maps that to `skipped_already_claimed` and returns. The claim is never retired, the enrollment is never paused, and this repeats on every cron cycle forever. The enrollment shows `status = 'active'` in the UI and has not sent anything since.

Concretely reachable — these three `tick.ts` sites call `markRunSkipped` (which sets `run_at = now()` and `attempt_outcome = 'not_attempted'`) and then `return { status: "failed" }` **without any `pauseEnrollment`**:

- template fetch error: `if (tmplErr) { await markRunSkipped(client, claim.id, "provider_failed"); return { status: "failed", ... } }` — a single transient read error on `sms_templates` permanently wedges the enrollment.
- `change_status` update error: `if (changeError) { await markRunSkipped(...); return { status: "failed", ... } }`.
- the trailing `Unsupported action_type` fallback.

Plus every path where `pauseEnrollment` itself returns an error after `markRunSkipped` succeeded.

The classification the rest of the design relies on is already available here: `definitively_rejected`, and `not_attempted` with `run_at` set, are exactly the two states `retry_sequence_step` accepts as proven non-sends. `retire_stale_sequence_claim` should retire them identically (set `claim_active = false`, stamp `failure_reason`, pause `provider_failed`) instead of returning `'active'`. Independently, the three `tick.ts` sites above must pause.

Related root cause worth fixing structurally: **`not_attempted` is overloaded.** It means both "claim created, nothing tried yet" and "we proved the provider was never invoked," and the only thing separating them is whether `run_at` happens to be set — which is precisely the fragile discriminator that produced this dead end. Consider a distinct terminal value (`'no_attempt_proven'`) or make `claim_active = false` the sole marker of terminality.

### 4. `reconciliation_required` is a one-way trapdoor with no in-product exit, and it is reached on a routine race

No RPC in the snapshot can resolve a `reconciliation_required` enrollment. `resume_sequence_enrollment` refuses it explicitly; `retry_sequence_step` requires `pause_reason = 'provider_failed'`; `resumeEnrollment` in `enrollment.ts` refuses it client-side too. The only recovery is raw SQL.

This would be acceptable if it were rare. It is not. In `tick.ts`, the success branch:

```ts
const advanceError = await advanceEnrollment(client, enrollment.id, enrollment.sequence_id, step.step_index);
```
and `advanceEnrollment` guards on `.eq("status","active").eq("current_step_index", currentStepIndex)`. **Any inbound reply that lands while the tick is in the provider call** causes `pausePropertyEnrollments` to flip the enrollment to `paused/inbound_reply`, `advanceEnrollment` misses, and the enrollment is left at step N with an `accepted`, still-`claim_active` claim. It looks fine — until an operator resumes it normally, at which point `resume_sequence_enrollment` finds the accepted claim and drops it into `reconciliation_required` permanently. For a campaign that actually gets replies, this is a steady-state leak, not an edge case. A crash between `authorize_sequence_provider_attempt` returning and `provider.sendSms` resolving produces the same end state via `retire_stale_sequence_claim`.

Required: an explicit operator resolution RPC, e.g.

```sql
resolve_sequence_reconciliation(p_enrollment_id uuid, p_claim_id uuid,
                                p_resolution text,       -- 'delivered' | 'not_delivered'
                                p_evidence text, p_actor_user_id uuid)
```
holding the enrollment lock: record the operator, evidence, and resolution on the claim; set `claim_active = false`; then either advance `current_step_index` past the step (`delivered`) or re-arm it for a fresh claim (`not_delivered`). Without this, the reliability work converts "occasionally double-sends" into "reliably and invisibly stops sending," which is not obviously the better failure mode for this product.

### 5. `resume_sequence_enrollment` will resume a `provider_failed` enrollment — the guard exists only in TypeScript, and the RPC is granted to `authenticated`

`enrollment.ts:resumeEnrollment` blocks `provider_failed` before calling the RPC:

```ts
if (enrollment.pause_reason === "reconciliation_required" ||
    enrollment.pause_reason === "provider_failed") {
  return { status: "reconciliation_required" };
}
```

but `resume_sequence_enrollment` itself only checks `reconciliation_required`:

```sql
if e.pause_reason = 'reconciliation_required' then ... end if;
```

and the migration ends with `grant execute on function public.resume_sequence_enrollment(uuid, uuid) to authenticated, service_role;`. Any org member can `POST /rest/v1/rpc/resume_sequence_enrollment` directly and bypass the TS wrapper entirely. The RPC then retires the `definitively_rejected` / `not_attempted` claim and re-arms the step — i.e. it becomes a `retry_sequence_step` that skips `assertNotTrainingTarget`, skips the `SEQUENCE_RESUMED`/retry lead event, and skips the deliberate separation between "resume" and "retry" that the whole design rests on. Combined with P1-8 (over-broad `definitiveRejection`), this is a live duplicate-send path.

Move the check into the RPC (`if e.pause_reason in ('reconciliation_required','provider_failed') then return 'retry_required'`), so `retry_sequence_step` is the only door.

### 6. `retry_sequence_step` gate is bypassed by a NULL `pause_reason` (three-valued logic)

```sql
if e.status <> 'paused' or e.pause_reason <> 'provider_failed' then
  return query select 'reconciliation_required', ...;
```

For a paused enrollment with `pause_reason IS NULL`, this evaluates `false OR NULL` → `NULL`, and plpgsql treats a NULL `IF` condition as false — **the guard does not fire and the retry proceeds**. Legacy rows and any direct `UPDATE sequence_enrollments SET status='paused'` produce exactly this state, so an enrollment that was stopped for an unrecorded reason can be re-armed and resume sending. The file already uses `coalesce(auth.role(), '')` in the authorization check, so the idiom is understood — it is just missing here:

```sql
if e.status <> 'paused' or coalesce(e.pause_reason, '') <> 'provider_failed' then
```

Sweep the file for the same pattern; `resume_sequence_enrollment`'s `if e.pause_reason = 'reconciliation_required'` has the same NULL behavior but fails into the claim fence, so it is safe by accident rather than by construction.

---

## P1 — Correctness and safety defects

### 7. Phone-suppression matching in `authorize_sequence_provider_attempt` is normalization-asymmetric

```sql
if exists (
  select 1 from public.sms_phone_suppressions ps
   where ps.org_id = e.org_id and ps.channel = 'sms'
     and regexp_replace(coalesce(ps.phone_e164, ''), '[^0-9]', '', 'g') = normalized_phone
)
```

`normalized_phone` has already been expanded to the 11-digit `1XXXXXXXXXX` form. `ps.phone_e164` is only digit-stripped, **not** expanded. Any suppression row stored as a bare 10-digit number (or with a leading `+` stripped inconsistently at write time) compares `'5551234567' = '15551234567'` → false → **the send is authorized past a recorded suppression**. This is the final compliance fence; it must apply the identical `CASE` expansion used two blocks above for contact phones. Preferably factor that expression into an `immutable` helper (`public.normalize_us_phone(text)`) and use it on both sides — and consider a functional index on the suppression table using it.

### 8. Sendillo classifies *all* 4xx as `definitiveRejection`, which is the only classification that authorizes a resend

`sendillo.ts:sendSms`:

```ts
...(response.status >= 500 ? { ambiguousDelivery: true } : { definitiveRejection: true }),
```

`classifySequenceProviderFailure` maps `definitiveRejection` → `'definitively_rejected'`, which is the state that makes `retry_sequence_step` (and, per P0-5, `resume_sequence_enrollment`) willing to re-send. A blanket "every 4xx proves non-delivery" is an over-claim against a provider whose error taxonomy the file elsewhere admits is undocumented ("the OpenAPI document confirms the endpoint but not every field name"). A 409 used for idempotency/duplicate conflicts, or a 4xx returned after partial acceptance, would authorize a duplicate SMS to a seller. Note also the internal inconsistency: `isTransientProviderError` treats 408/425/429 as retryable-transient while this call site brands them definitive.

Narrow to an allowlist of codes whose meaning is actually known (400/401/403/404/422, ideally further qualified by a parsed error code from the body), and default every other 4xx to no flag → `'unknown'`.

### 9. The abort timer is cleared before the response body is read, leaving the read unbounded

`sendillo.ts:sendSms`:

```ts
} finally {
  clearTimeout(timeout);
  opts.signal?.removeEventListener("abort", onExternalAbort);
}

const text = await response.text();
```

`DEFAULT_SEND_TIMEOUT_MS` bounds only the header exchange. A response whose body never completes hangs `await response.text()` with no timeout and no abort listener attached. In the sequence path this hangs the tick *after* `authorize_sequence_provider_attempt` has written `unknown` — the platform eventually kills the process, and the enrollment lands in the P0-4 trapdoor. Keep the controller live across the body read (clear the timer after `text()` resolves, in a second `finally`), or use `AbortSignal.timeout` on the whole operation. Same pattern in `fetchCatalogList` (lower stakes).

### 10. The quiet-hours branch hard-DELETEs the claim, unguarded, with two unchecked writes

`tick.ts`, `case "blocked_quiet_hours"`:

```ts
await client.from("sequence_step_runs").delete().eq("id", claim.id);
await client.from("sequence_enrollments").update({ next_run_at: ... }).eq("id", enrollment.id);
```

Three problems in five lines:

- **No predicate on `attempt_outcome` or `claim_active`.** This is the one place in the entire design that destroys the fence by row deletion rather than retiring it. It is currently safe only because `checkQuietHours` happens to run before the `messages` insert and before `authorize_sequence_provider_attempt` in `send.ts` — an ordering invariant nothing enforces. Any future reordering of `send.ts`'s pre-send checks turns this into an unconditional duplicate-send. Add `.eq("attempt_outcome", "not_attempted")` at minimum.
- **It contradicts the audit model.** The migration comment says retries "retain the old row for audit"; this silently erases the quiet-hours skip. Prefer `update ... set claim_active = false, run_at = now(), skipped_reason = 'quiet_hours'`.
- **Neither write's error is checked.** If the delete fails, the claim survives `not_attempted`/`run_at is null`; 10h later the tick hits 23505 → `retire_stale_sequence_claim` → retired → the enrollment is **paused `provider_failed`**, converting a routine quiet-hours reschedule into a manual-repair item. If the `next_run_at` update fails, the enrollment re-ticks every cron cycle until the window opens. Check both and return `failed` on either.

### 11. Permanent (opt-out) transitions do not apply to already-paused enrollments

`tick.ts:pauseEnrollment`, `enrollment.ts:pausePropertyEnrollments`, `enrollment.ts:pauseContactEnrollments` all filter `.eq("status", "active")`.

A STOP keyword arriving while an enrollment is `paused` (`inbound_reply`, `call_in_progress`, `template_missing`, …) updates **zero rows**. The enrollment is never marked `opted_out`, `next_run_at` is never cleared, `paused` is returned as `0`, and consequently **no `SEQUENCE_PAUSED` lead event is recorded at all** — the opt-out leaves no trace on the enrollment record. An actual send is still blocked downstream by `getConsentState` and by the RPC's `consent_events` check, so this is not a send defect; it is a stopped-state and audit defect, and it means the enrollment remains visibly resumable to an operator after the contact has opted out.

Permanent transitions should match `status in ('active','paused')`; only the non-permanent ones should stay `active`-only.

### 12. `p_stale_before` is computed on the app host, so clock skew drives recovery

`tick.ts`: `p_stale_before: new Date(Date.now() - SEQUENCE_CLAIM_STALE_MS).toISOString()`.

An app clock ahead by >15 min makes `retire_stale_sequence_claim` retire a claim that a sibling worker inserted seconds ago and is about to authorize — the sibling's `authorize` then denies (`claim is not active`, `definitively_rejected`) and the enrollment is spuriously paused. A clock behind by >15 min disables stale recovery entirely, silently. Pass an interval and let the database compute the boundary:

```sql
create or replace function public.retire_stale_sequence_claim(
  p_enrollment_id uuid, p_step_id uuid, p_claim_id uuid, p_stale_after interval)
...
if coalesce(r.attempt_started_at, r.created_at) > now() - p_stale_after then
```

### 13. `processEnrollmentTick` and `sendSmsToContact` both throw despite documenting that they don't

`sendSmsToContact`'s doc comment says "Never throws — returns a discriminated outcome," but its first statement is `await assertNotTrainingTarget(...)`, outside any `try`. `processEnrollmentTick` likewise has unguarded `await`s on `assertNotTrainingTarget` (transitively), `loadTemplateVars`, `pickFromPool`, and `renderTemplate`. A throw escapes `processEnrollmentTick` entirely, leaving the claim active and `not_attempted` — recoverable in 15 minutes via `retire_stale_sequence_claim`, but only for that one enrollment. If `/api/cron/sequence-tick`'s loop is not per-item try/caught (not in the snapshot — please confirm), **one bad enrollment aborts the whole batch**, so every remaining due enrollment silently misses its window. Wrap the body of `processEnrollmentTick` in a try/catch returning `{ status: "failed" }`, and confirm the cron loop guards each iteration.

### 14. Substantive addition to the known `db_error` fix: use the evidence the outcome already carries, and make the switch exhaustive

Not re-raising the known defect, but the fix has a precise discriminator available and the `default:` block needs structural protection:

`sendSmsToContact` returns `db_error` from five distinguishable positions, and the shape of the returned object already encodes the evidence:
- `{ status: "db_error", error }` with **no `messageId`** — contact/property fetch, phone-suppression check, `ensureConversationIdForThread`, pending insert. Provider was never reached → `not_attempted`.
- `{ status: "db_error", messageId, externalId }` — both the post-`retryReceiptTransaction` failure and the `providerAccepted === true` catch branch. The provider **accepted** → `accepted`, never `not_attempted`.
- anything else → `unknown`.

So the mapping is `"externalId" in outcome ? "accepted" : "messageId" in outcome ? "unknown" : "not_attempted"` — driven by evidence rather than by the status string.

Separately: the `default:` arm currently absorbs `blocked_landline`, `blocked_fresh_state_unavailable`, `blocked_not_due`, `blocked_campaign_paused`, `provider_deferred`, and `paused`, and assigns them `"not_attempted"`. That is correct today for the reachable ones, but it means **any future `SendSmsOutcome` variant silently defaults to "no send happened"** — the single most dangerous default in this codebase. Add an exhaustive check so a new variant is a compile error:

```ts
default: {
  const _exhaustive: never = outcome;  // after handling every non-provider status explicitly
  ...
}
```

### 15. Substantive addition to the known `markRunSkipped` fix: the write needs a predicate, not just a better value

`tick.ts:markRunSkipped` writes `attempt_outcome` unconditionally. Beyond preserving ambiguity, the write must be guarded so it can only ever *advance* a claim's evidence state:

```ts
.eq("id", runId)
.eq("attempt_outcome", "not_attempted")   // never overwrite recorded provider intent
```

The reason a predicate (not merely a corrected value) is required: `authorize_sequence_provider_attempt`'s "already has a provider outcome" denial returns `r.attempt_outcome` to the caller, and `case "blocked_sequence_authorization"` feeds that straight back into `markRunSkipped` — so the denied caller writes `run_at` and `skipped_reason` onto a claim row that a *different* execution may be actively using. A guarded write makes that a no-op instead of a cross-worker stomp. Also check the row count and surface a `failed` outcome when the guard rejects, rather than discarding the result (the current call sites ignore `markRunSkipped`'s return entirely).

### 16. Actor attribution is mutually exclusive with service-role execution

Both `retry_sequence_step` and `resume_sequence_enrollment` reject when `auth.role() = 'service_role' and p_actor_user_id is not null`. `enrollment.ts` passes `p_actor_user_id: actor.actorType === "user" ? actor.actorId : null` — so **if any of these call sites runs on a service-role client (the usual shape for a Next.js server action), every operator-initiated resume/retry fails** with `{ status: "failed", message: "Enrollment resume was not authorized" }` or a misleading `reconciliation_required`. If the call sites use a user-JWT client instead, it works but the org membership check is the only authorization — with no role gating on an action that causes an SMS to be sent.

Please confirm which client each call site uses; I cannot from the snapshot. Either way the design forces a choice between "rejected" and "no attribution," and **neither RPC writes an audit row inside its own transaction** — the `SEQUENCE_RESUMED` lead event is written afterwards in TS and is lost if that write fails. Record the actor and the retired claim id inside the RPC transaction, and add an explicit, separately-authorized "on behalf of" parameter for trusted server callers.

---

## P2 — Should fix before production readiness is claimed

17. **Consent tie-break can lose an opt-out.** `order by ce.occurred_at desc, ce.id desc` in `authorize_sequence_provider_attempt` — `id` is a UUID, so when an opt-in and an opt-out share `occurred_at` (backfills, same-request writes, date-precision imports) the winner is arbitrary. Opt-out must win ties: add `(ce.event_type in ('opt_out','provider_auto_opt_out')) desc` as the second sort key. Also confirm this ordering matches `getConsentState`'s — two implementations of "latest consent" that disagree is a compliance incident waiting to happen.

18. **Suppression policy is duplicated in SQL and TypeScript.** The RPC hardcodes `('wrong_number','bad_number','dnc','opted_out','nurture','callback_requested','booked_appointment')` and `('dead','closed','offer_sent','under_contract')`; `suppression.ts` owns `SUPPRESSED_DISPOS`/`HUMAN_OWNED_DISPOS`. Adding a dispo in one place silently leaves the other fence open. Drive both from a table, or add a test that asserts set equality against `pg_get_functiondef`.

19. **Deactivating a sequence does not stop in-flight enrollments.** Neither `tick.ts` nor `authorize_sequence_provider_attempt` checks `sequences.active` or `sequences.archived_at` (the RPC checks only `seq.org_id = e.org_id`). `enrollLead` checks it at enrollment time only. An operator who archives a sequence to stop it will watch it keep sending. Add `and seq.active and seq.archived_at is null` to the RPC's existence check.

20. **`skipped_reason = 'provider_failed'` is written for six non-provider failures** (template fetch error, template missing, empty pool, empty body, `change_status` error, unsupported action type). This poisons the exact field operators will use to triage duplicate-send risk, and it collides with the `pause_reason` value that means "safe to retry." The enum already has an unused `escalated` member; add `step_error` and use it.

21. **`resumeByProperty` is an un-fenced direct UPDATE.** `enrollment.ts:resumeByProperty` flips `status='active', next_run_at=now()` for `pause_reason='call_in_progress'` without consulting claim state. Scoped narrowly enough that it cannot resurrect a `reconciliation_required` row, but it *can* re-activate an enrollment holding an `accepted` claim at the current step (the P0-4 race), which then stalls for 15 minutes and terminates in the trapdoor. Route it through `resume_sequence_enrollment`.

22. **Claim retirement loses its reason.** `resume_sequence_enrollment` and `retry_sequence_step` both do a bare `update ... set claim_active = false`, unlike `retire_stale_sequence_claim` which stamps `failure_reason`. Post-incident you cannot tell why a claim was retired or by which path. Stamp a reason and the actor in all three.

23. **`retry_sequence_step` reports authorization failures as `reconciliation_required`.** A non-member's denied call is indistinguishable from a genuine ambiguous-delivery state, both in the RPC return and in `retrySequenceStep`'s mapping (`result.outcome !== "retried"` → `reconciliation_required`). This masks authorization failures as a system incident and will send operators chasing a nonexistent reconciliation. `resume_sequence_enrollment` gets this right with a distinct `not_authorized`; mirror it.

24. **`retrySequenceStep` is missing `assertNotTrainingTarget`,** which `enrollLead`, `resumeEnrollment`, and `resumeByProperty` all call. The guard still holds at send time inside `sendSmsToContact`, but it holds by *throwing* out of a function documented not to throw (see P1-13), leaving a claim behind. Add the assert at the top of `retrySequenceStep`.

25. **Accepted claims stay `claim_active = true` forever.** Nothing retires a claim on successful advance, so the "active" partial index asymptotically covers the whole table, and `claim_active` comes to mean "not superseded" rather than "live claim." Worth deciding deliberately: retiring on successful advance makes `current_step_index` the fence for completed steps and would dissolve the P0-4 trapdoor for the non-racing case — but only adopt it together with the resolution RPC in P0-4, not instead of it.

26. **`attempt_count` is incremented and never bounded.** No cap, no alert threshold. A claim that oscillates through retry can attempt indefinitely. Add a ceiling check in `retry_sequence_step`.

27. **Non-US numbers produce a misleading terminal rejection.** `authorize_sequence_provider_attempt` sets `normalized_phone := ''` for anything that is not 10 digits or 11 digits starting with `1`, then fails with `'selected phone is no longer saved on contact'` — a phone that is in fact saved. Emit a distinct `failure_reason` (`'phone is not a supported US number'`).

28. **`enrollLead` checks `getConsentState` but not `do_not_contact`, `sms_opted_out`, or `properties.is_dnc_locked`.** A suppressed contact enrolls cleanly, then the first tick authorizes-denies, pauses `provider_failed`, and presents an operator with a retry button that can never succeed. Mirror `evaluateSuppression` at enrollment time.

29. **Webhook secret accepted from the query string.** `sendillo.ts:verifyWebhookSignature` → `readQuerySecret(fullUrl, "secret")`. URLs are logged by proxies, CDNs, and access logs; a shared secret in a query parameter should be treated as disclosed. Out of scope for sequence reliability, but it is in a file you supplied and it is a standing credential-leak path — restrict to the header/bearer candidates.

30. **No cross-sequence per-contact cooldown.** The fence is per `(enrollment, step)`. A property enrolled in three sequences can receive three SMS within one cron cycle, and `authorize_sequence_provider_attempt` — the stated "final native-sequence gate" — checks nothing about recent sends to that phone. May well be an accepted product decision; flagging so it is an explicit one rather than an emergent one.

---

## Verdict

**CHANGES REQUIRED.**

This is a source review only; it is not a deployment approval and nothing here should be read as one. Runtime execution has not been established (host ENOSPC), so every finding above is static-analysis reasoning over the snapshot and needs confirmation against a live database before it is considered either fixed or dismissed.

Gating items, in order: **P0-1** (migration backfill and column default — this one damages existing data the moment it runs and must be corrected before the migration is applied anywhere with real rows, including any test database you intend to trust), **P0-2** (index-drop assertion), **P0-3** (stale-claim dead end), **P0-4** (reconciliation exit path), **P0-5** (resume bypassing the retry gate), **P0-6** (NULL `pause_reason`). P1-7 through P1-16 should land before the phased test plan's duplicate-send and recovery scenarios are run, since several of them are exactly what those scenarios are meant to detect and leaving them in will produce test failures that get triaged as test-harness problems.

One note on the migration status: you reported it as already applied. If it was applied to a database containing real `sequence_step_runs` history, **that data is already in the P0-1 state** and needs the corrective backfill before anything reads it — the rows are not self-healing, and a subsequent corrected migration will have no way to distinguish a genuinely in-flight claim from a historical row that the first migration mislabeled, unless `run_at`/`message_id`/`skipped_reason` are still intact (they should be — nothing in this changeset overwrites them for untouched rows). Verify that before writing the backfill.