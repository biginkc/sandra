# My Leads saved queue — implementation plan (performance only), rev 5

Source: origin/main 2880ba5e69c6 (re-fetched 2026-10-21; latest defining migration checked per function). Live classifier: `my_leads_work_classified_ids` / `my_leads_work_classified` / `fn_my_leads_work_facts` in `supabase/migrations/20261021090000_my_leads_work_classified_cached.sql`; `fn_my_leads_work_page` and `fn_my_leads_badge_v2` in `20261015010000_my_leads_work_queue_classifier.sql:486,588`; **`my_leads_queue_rows_for` is the 20261005121000_next_step_read_model.sql:23-81 body** (replaced the Oct 3 body: tasks filtered by `next_step_kind = 'appointment'`, exposes `nextStepMode` from `tasks.mode`, `nextStepType` is now the constant 'appointment' when a step exists); the `my_leads_queue_rows` wrapper is still 20261003120000_my_leads_queue_row_lookup.sql:84. Generation, the one-source generator and parity all target these current bodies.

## Rule carried into every PR and every subagent brief
Performance only. No LLM may add, edit or remove a business rule (tabs, stages, chips, ordering, due times, counts, tie rules, badge membership). The saved queue must return output row-for-row and byte-for-byte identical (including `facts` JSON and its `row`) to the live classifier at the same `p_at`. Wherever incremental work could diverge, fall back to a full recompute; never change behaviour to make caching easier. Contradictions between rules are reported to Jarrad, never resolved. No destructive ops on prospects/leads; migrations only via merge to main → `db-migrate-test.yml` → `db-migrate-prod.yml`.


- Fable rulings (verbatim, binding):
  - RULING MLQ-1: Direction A is approved in principle; PR-0 becomes a decision gate with the rule in finding 4, and C's narrow fixes ship first if they clear the budget. Rationale: the 10 s has not been attributed yet; A's per-lead recompute inherits whatever dominates.
  - RULING MLQ-2: Every invalidation trigger is fail-open with local lock_timeout and an ingest-survives test; a trigger may never fail a write to `messages` or any other hot table.
  - RULING MLQ-3: Mismatch and repair are defined snapshot-safely (finding 2); the 7-day zero-mismatch criterion counts only confirmed mismatches, and the auto kill-switch flips only on a confirmed one.
  - RULING MLQ-4: `valid_until` and the trigger column lists are derived mechanically from every `p_at` comparison and every column read in both the classifier and `my_leads_queue_rows_for`, with the parity harness asserting equality at ±1 ms around every derived boundary; anything unbounded is never cached.
  - RULING MLQ-5: Readers wait on the per-member lock and serve from the table; live is the fallback only when the lock cannot be acquired.
- Architect notes: (a) the parity harness becomes a permanent CI gate; (b) the cacheable body and the live classifier are generated from one source, never hand-synced.


## Fable review 2 — binding addendum (FABLE_APPROVE: YES, BLOCKING: 0)

Rulings (verbatim, binding; they override any conflicting text above):
- RULING MLQ-6: `lock_timeout` for invalidation triggers is set as a function-level `SET` on the trigger function, never `set local` inside the body.
- RULING MLQ-7: A mismatch is confirmed iff no dirty mark exists for that lead at compare time; no timestamp comparison, no "no relevant commit" test.
- RULING MLQ-8: The dirty table is append-only with no unique constraint; marking never waits on another transaction.

Implementation notes from the same review (apply in the named PRs):
1. MLQ-6 settles the §6 lock_timeout open item; remove it.
2. MLQ-7 replaces the `marked_at > cache.computed_at` gate everywhere (shadow compare, reconcile, cutover, kill switch). Recompute deletes the marks it consumed, so any surviving mark is a write not yet in the cache.
3. MLQ-8: `my_leads_queue_dirty` is an append-only log (plain inserts, no unique constraint); the reader deletes the rows it consumed.
4. Statement-level triggers (`messages`, ledger with transition tables) cannot use `WHEN (old.col IS DISTINCT FROM new.col)`; compare `old_rows`/`new_rows` inside the function and use `UPDATE OF <cols>` on the trigger. Row-level `WHEN` stays for `properties`, `contacts`, etc.
5. PR-3's body states the accepted risk plainly: in `on` mode a failed mark can leave a lead in the wrong tab until the hourly reconcile; the cutover criterion and auto kill switch bound it.
6. Keep the trigger `raise warning` and count those warnings on the PR-3 dashboard so a broken trigger is noticed before the hourly run.
7. Parity gate for `my_leads_queue_member_ids`: its output must equal the id set of `my_leads_queue_rows_for(..., null)` on every fixture.

## Fable review 3 — rulings (verbatim, binding; supersede MLQ-4 and MLQ-7 above)
- RULING MLQ-4 (rev): `valid_until` and the fingerprint dependency map are derived from the single classifier source and verified semantically by a column-mutation sweep run under every existing parity fixture suite: every column of every dependency table, plus insert and delete of a row on every dependency path, on the lead, its homeowner contact, every sibling, every foreign-receipt property and every enrolled sequence, asserting that the fingerprint changes whenever live output changes and that the cache read equals live; the harness asserts equality at b−1 ms, b−1 µs, b, b+1 µs, b+1 ms around every derived boundary including America/Chicago DST transitions; anything unbounded is never cached.
- RULING MLQ-7 (rev): A mismatch is confirmed iff live and cache-path outputs differ when both are computed inside one SQL statement under the member lock, both classifier functions STABLE so they share that statement's snapshot; a run that cannot satisfy this is skipped, never counted. REPEATABLE READ is not used on any PostgREST path.
- RULING MLQ-9: The read protocol is READ COMMITTED: statement 1 takes the member advisory lock; statement 2 is one SQL statement that fingerprints, recomputes changed ids through the STABLE cacheable function, upserts and deletes via data-modifying CTEs, and serves the union of unchanged cached rows and the CTE's returned rows. No cache state is read or written outside that statement.
- RULING MLQ-10: Membership changes are handled as a diff (compute joined, delete departed); a full rebuild occurs only on membership-table, org-settings, flag or generation change.
- RULING MLQ-11: PR-0 is the go/no-go for A: fp p95 ≤ 250 ms on the 1,755 queue at the production read pattern and 20-lead recompute ≤ 150 ms, or the work stops at C and PR-0 records the result; no partial A ships.
- Status: **MLQ-6 and MLQ-8 are DORMANT** (no invalidation triggers, no dirty table in this design; they revive only if either is reintroduced). **MLQ-2 accepted addition:** if no invalidation triggers exist, MLQ-2 is satisfied by an unchanged write path; the ingest-survives test still runs. **Addendum notes amended as ruled:** note 4 → statement-level triggers with transition tables are declared without `UPDATE OF`, the function compares `old_rows`/`new_rows` itself (moot here); note 5 → in `on` mode a cached row is served only when fingerprint and valid_until prove it current, no accepted wrong-tab window; note 6 → dashboard counts fp-mismatch recomputes and lock-timeout live fallbacks.
- Architect notes (rev 4): fingerprint, cacheable body and live classifier come from ONE generator; the sweep is the proof. PR-0 is read-only on prod; the fp prototype is ad-hoc SQL, not a migration.

## Core change in rev 3: read-time proof, not trust in triggers
Rev 2 trusted invalidation triggers. When a trigger failed open, a lead could sit in the wrong tab until reconcile ran (Astra blocker 1).

Rev 3 serves a cached row only when a read-time check proves the row's inputs are unchanged since it was computed. Each cached row carries an **input fingerprint**. This is a hash over every database row the live classifier could read for that lead, computed by the database at read time.

Triggers are **removed** from the design. Nothing is added to the write path, so no write can ever fail or slow down because of the cache (MLQ-2 holds trivially). No mark can be missed, because there are no marks.

A row is served from cache iff all of these hold:
- its stored fingerprint equals the fingerprint recomputed now;
- `computed_for_at <= v_at < valid_until` (lower bound: an earlier-started request that gets the lock after a later one must not accept output computed for its future);
- the row's stored state components (`row_ofp`: memberships, org settings, flag) and `generation` equal the current ones.

Otherwise the row is recomputed live in the same transaction.

## 1. Inventory and dependency map (checked against origin/main)

**Per-lead row fingerprint `fp(member, lead)`.** For each source, hash `(table, ctid, xmin)` of every row reachable by the paths below. Any INSERT, UPDATE (including HOT updates), DELETE or TRUNCATE changes the hash. That holds no matter who writes: app code, service role, import, `session_replication_role = replica`, or manual SQL. Freezing keeps the `xmin` value as read.

**Rows reached through the lead itself (L):**
- `properties` (L); `acquisition_queue_states` (L); the open `acquisition_assignment_episodes` row(s) for L (queue_rows_for 20261005121000:42). Membership predicate (do not re-type; note 7): episode open + assignee = member (:42), `p.assigned_user_id = member`, not deleted, not `is_dnc_locked`, status not in ('closed','dead','dnc'), `q.archived_at is null` (:55-56).
- `tasks` by related_property_id (classifier: `next_step_kind = 'appointment'` :261, :328; queue_rows_for :45-50 reads `next_step_kind`, `status`, `due_at`, `snoozed_until`, `mode`); `acquisition_offers`; `acquisition_attempts`; `call_activities`; `lead_notes`; `lead_events`.
- `norma_call_requests`; `rep_sms_obligations`; `ai_reply_dead_letters`; `ai_reply_drafts`.
- `my_leads_strip_overrides` (org, member, L).
- `messages` (sms) by property_id = L.

**Rows reached through the homeowner contact (C = L.homeowner_contact_id):**
- `contacts` (C); `messages` with property_id null and contact_id = C (:61, :152).
- The **sibling set** S = `properties` where homeowner_contact_id = C and deleted_at is null (cs :141-143). Siblings can sit outside the member's queue.
- For every s in S, the rows cm/chd read (:149-190):
  - `messages` (outbound) by property_id = s;
  - inbound `messages` matched by id from metadata (`inbound_message_id`);
  - `rep_sms_delivery_ledger` by message_id of those messages (clg);
  - `acquisition_attempts`, `lead_events` and `sequence_enrollments` by property_id = s.
- Hashing all of S's rows, not just its id list, catches reparenting (a homeowner change on any sibling, or a sibling deleted or undeleted).

**Rows reached through sequences:**
- `sequence_enrollments` by L; `sequence_step_runs` by enrollment and by message_id of L's messages (the is_drip test at :103, :155).
- `sequence_steps` and `sequences` for each enrolled sequence (:226-243). A step edit changes the fp of every enrolled lead.

**Receipts:**
- `rep_sms_delivery_ledger` rows with message_id in L's (and C's) messages, whatever their property_id.
- Ledger rows with property_id = L (:163, :375, :437).
- **lg membership coupling:** lg (:66) keeps a receipt only if its property_id is in the queue. So the fp also hashes the *queue-membership bit* of every foreign property_id seen on L's receipts. If such a property joins or leaves the queue, L's fp changes.

**Indirect-id paths (re-audit of the whole 20261021090000 body for "joined via another row's id"; every one is in the fp and in the sweep):**
1. L's messages → `sequence_step_runs` by message_id (is_drip, :103). The run may belong to any enrollment.
2. **Sibling/contact messages (cm) → `sequence_step_runs` by message_id (:155)**, including siblings outside the queue. Inserting a run turns a sibling's answering text into drip and can restore "New reply" on L (Astra review 2).
3. L's messages → ledger by message_id, filtered to queue property_ids (lg :65-69).
4. cm messages → ledger by message_id, no property filter (clg :162-165).
5. L outbound `inbound_message_id` stamp → inbound message by id (:94-97).
6. cm stamp → inbound message by id (:172-177).
7. lo → `sequence_step_runs` by message_id → `sequence_enrollments` by `r.enrollment_id`, which may be another lead's → `sequence_steps` by `r.step_id` and max `step_index` by `e2.sequence_id` (lo_final :222-230).
8. en → `sequences` by `e.sequence_id`; `sequence_steps` count by sequence_id; `sequence_step_runs` by `enrollment_id` (claim_at, last_sent_at :234-243).
9. bko → `lead_events.source_id` matched to broken item `ref_id` (:404). Keyed on L's events, so already covered; listed for completeness.
10. Contact → sibling properties (:143) and contact-only messages (:61, :152).

The fp hashes the target rows of every path above (on the dependency side, not only L's own rows). The column-mutation sweep inserts and deletes a row at the far end of each path, e.g. a step run keyed to a sibling's message, or an enrollment of another lead referenced by L's drip run.

**Inbound reply stamps:** `messages` referenced by any id read through `stamp`/`inbound_message_id` (:95, :172-175).

**Org/member fingerprint `ofp(org, member)`.** Computed once per read:
- `memberships` (member); `acquisition_org_settings`; `my_leads_feature_flags`;
- the inputs of `my_leads_require_read_scope`;
- the **membership id-set hash**, from `my_leads_queue_member_ids` (note 7 parity gate).

A change to ofp's memberships/org-settings/flag/generation components means a full rebuild; a membership id-set change is a diff (MLQ-10). Departed leads are deleted and joined leads computed.

**Code version.** `generation` is a constant compiled into the cacheable function by the one-source generator. Any migration that touches the classifier, queue_rows_for or the fp function bumps it, which invalidates every cached row.

**Time.** `valid_until` is the earliest moment the cached output could change with no write. It covers:
- every `next_change_at` term;
- `soon` (row 4, :578);
- the overdueDays daily tick (row 9, :579);
- the drop of `nextStepAt`/`nextStepType`/`nextStepMode` when the earliest appointment task's effective time `greatest(due_at, snoozed_until)` is no longer `> p_at` (queue_rows_for 20261005121000:46-48). It is in next_change_at only when stage = 'contacted' (:66), so it gets its own valid_until term;
- warning thresholds: first_call_overdue via `acquisition_working_deadline`, needs_offer +12 h, offer follow-up, missing_next_step (queue_rows_for 20261005121000:35-37, :58-66);
- the America/Chicago 7-day window (:267-283);
- `my_leads_add_business_days` / `acquisition_working_deadline` (Mon–Fri arithmetic, no holiday table);
- the minimum future-stamped `created_at/occurred_at/started_at/recorded_at` among the fp rows.

Any `p_at` term with no computable boundary sets `valid_until = p_at`, so that row is never cached.

## 2. Options
C (narrow CTE fixes) goes first per MLQ-1, then A (saved queue, fingerprint-validated). B (TTL) is rejected: stale output is not identical to live. If PR-0 shows fingerprints can't be cheap, A can't be proven exact, and we stop at C.

## 3. Design

**One source.** The classifier SQL is a single template. The generator emits:
- `my_leads_work_classified_ids` (live; output byte-identical to today);
- `my_leads_work_classified_ids_cacheable` (the same body plus `valid_until`);
- `my_leads_queue_fp(org, member, p_ids)`, built from the same dependency map as the template's joins.

CI fails if the generated outputs differ from what is checked in.

**Schema:**
- `my_leads_queue_cache(org_id, member_id, property_id, <20 output columns>, computed_for_at timestamptz, valid_until, fp bytea, row_ofp bytea, generation int, computed_at)`, PK (org, member, property).
- `my_leads_queue_cache_state(org_id, member_id, ofp bytea, generation, built_at)`.
- `my_leads_queue_cache_mismatches`.
- No dirty table. RLS on, no grants to `authenticated`, no FK cascades onto leads.

**Read protocol (MLQ-9; page, badge, facts — already VOLATILE; READ COMMITTED; never REPEATABLE READ).**
0. Only "now" reads touch the cache: any explicit `p_at` (historical or future) → live only, no cache write. Flag `off` → live.
1. **Statement 1:** `pg_advisory_xact_lock(hashtextextended(org||member))`, bounded wait ~8 s (MLQ-5; `lock_timeout` on the function). Not acquired → live, no write.
2. **Statement 2 — one SQL statement**, so everything shares one snapshot taken after the lock: CTEs compute `ofp` + generation and the cache state; `my_leads_queue_member_ids` (current members); `fp` for cached ids; `chg` = ids with fp differing, `valid_until <= v_at`, stale generation, or newly joined; `rc` = `_cacheable(org, member, v_at, chg)` (STABLE); `up` = `insert … on conflict do update … returning *` from `rc`; `del` = `delete` of departed ids (MLQ-10 diff) `returning property_id`; a state upsert CTE. The statement serves `(cached rows where id not in chg and not departed) union all (up returning rows)`, ordered `place_rank, sort_rank, sort_key, last_touch_epoch, property_id`. The cache table is never re-read after writing within the statement — fresh rows come only from RETURNING.
3. **Full rebuild** (all ids into `chg`, same single statement) only when the state row is missing or ofp's memberships / org-settings / flag component or generation changed (MLQ-10). Queue membership changes are a diff, not a rebuild.
4. **Facts** reads only `ofp` and `fp` of the requested ids (≤ 50) and **never advances shared state**: it writes no state row and no cache rows. A requested id is served from cache only if every serve condition holds, including `row_ofp` = current ofp. Otherwise that id is served live (in-statement STABLE live CTE). `missing` is derived from `my_leads_queue_member_ids` (note 7 parity gate), never from cache presence. Page and badge need the whole set.
5. **Serve conditions (all statements):** fp match; `computed_for_at <= v_at < valid_until`; `row_ofp` and generation match; the row exists. A member id with no cache row counts as changed, even if the recorded membership set lists it. A row that fails any condition is recomputed (page/badge) or served live (facts). Recomputed rows store `computed_for_at = v_at`. `v_at` keeps today's semantics (`statement_timestamp()` captured at RPC entry); only the cache acceptance window changes.
No cache state is read or written outside statement 2. The STABLE classifier functions see statement 2's snapshot; a write committed after it is caught by the next read's fingerprint.

This keeps one member's refresh from affecting another member's cache: every row and fp is per (org, member).

`lg` still scans the whole queue's receipts when `p_ids` is used (:66). PR-0 measures this, and the PR-0b narrow fix may address it.

## 4. Correctness gate
**Snapshot-consistent compare (MLQ-7 rev).** Shadow compare = the same two-statement shape: statement 1 takes the member lock; statement 2 adds the live classifier (`my_leads_work_classified_ids`, STABLE) as another CTE beside the cache-path CTEs and writes per-field differences to `my_leads_queue_cache_mismatches` via a data-modifying CTE. Both sides share one snapshot, so any difference is a confirmed cache bug. In `shadow` the served result is the live CTE. A run that cannot meet this (lock not acquired, statement error) is `skipped`, never counted. Reconcile (Vercel cron, hourly + nightly, direct connection) uses the identical shape. No REPEATABLE READ anywhere on PostgREST paths.

**Parity harness (permanent CI gate).** It extends `20261021090000_my_leads_work_classified_cached.integration.test.ts`:
- **Column-mutation sweep (MLQ-4 rev).** Runs under EVERY existing parity fixture suite (all placement rows 1–15, both tabs). For every column of every dependency table (from `information_schema`), mutate it; and on every dependency path insert and delete a row — on the lead, its homeowner contact, every sibling, every foreign-receipt property, every enrolled sequence. Assert: live output changed ⇒ fp changed, and cache read = live. Any miss fails CI.
- **Fan-out cases:**
  - homeowner reparent (old and new contact);
  - sibling delete/undelete;
  - lead reassign between members (both members' caches);
  - membership change of a foreign-receipt property;
  - sequence step edit;
  - bulk insert under `session_replication_role = replica`;
  - TRUNCATE/restore of a fixture table;
  - service-role writes.
- **Boundaries:** for every derived boundary b, read at b−1 ms, b−1 µs, b, b+1 µs and b+1 ms. Include DST spring-forward and fall-back in America/Chicago (missing and repeated hour) for the 7-day window and the business-day arithmetic, plus Friday-to-Monday and month and year rollovers. Boundary reads go through the **cache path and must be cache hits** where the conditions allow, not only live calls. Assert a hit on the near side, a recompute on the far side, and byte equality with live on both. **Out-of-order case:** request R1 captures v_at = b−1 µs, request R2 captures b+1 µs and takes the lock first and caches; R1 then gets the lock. R1 must reject R2's rows (`computed_for_at > v_at`), recompute, and equal live at b−1 µs. Explicit `p_at` calls are asserted to bypass the cache and write nothing. **Facts and state case:** an org-settings or membership change followed by a facts call must not let untouched rows pass a later page read (`row_ofp` mismatch triggers a recompute).
- **Concurrency (readers × writers × refresh):** randomized interleavings across N parallel sessions (two readers of one member, one reader per member on a shared lead, a writer on L/C/siblings, a reassign and a bulk load). Assert that every served result equals a live result for a snapshot within the reader's transaction, and that the cache state after quiesce equals a fresh full build.
- **Fail-safe:** with the cache tables dropped or locked, page, badge and facts still return live output, and writes to `messages` succeed (MLQ-2's ingest-survives test is kept, now against an empty write path).

**Kill switch and cutover:**
- `my_leads_feature_flags.saved_queue` takes `off`, `shadow` or `on`.
- A confirmed mismatch flips that org to `off` and alerts.
- Cutover needs 7 days and at least 5,000 compared reads (at least 500 for the 1,755-lead member) with zero confirmed mismatches (MLQ-3).
- Reconcile runs hourly plus nightly (Vercel cron; the repo has no pg_cron).

**Rollback:** set the flag to `off`. The rollback SQL restores the 20261021090000 page/badge/facts bodies. The cache tables are disposable.

## 5. Rollout
1. **PR-0: profile and gate** (read-only `EXPLAIN (ANALYZE, BUFFERS)` on prod for the 1,755, 445 and 54-lead members). Measure:
   - (a) time per CTE;
   - (b) `_ids(p_ids)` cost at 1, 20 and 100 leads, including the lg floor;
   - (c) the **prototype fp query** (ad-hoc read-only SQL, not a migration) for the 1,755 member at the **production read pattern** (3 tabs × 30 s page + badge + facts), with `BUFFERS`. fp is bounded below by the classifier's heap reads (`xmin` lives in the tuple header, so every dependency row is a heap fetch; sibling/receipt paths are read for every lead with a contact);
   - (d) the shadow overhead estimate (the 1.05× claim is unproven until measured);
   - (e) whether a larger compute tier helps. BUFFERS can't show this, so PR-0 also records `pg_stat_statements` (total/mean time and shared reads), `pg_stat_activity` wait-event sampling during the replayed read pattern, and `EXPLAIN (ANALYZE, BUFFERS, TIMING)` with `track_io_timing` if enabled (read-only check of the setting; not changed). "Compute alone is insufficient" is now a measurement, not a claim.

   **Gates (MLQ-1, MLQ-11):** C first if ≥ 70% of time sits in one or two fixable CTEs. Go for A only if fp p95 ≤ 250 ms at the production read pattern and 20-lead recompute ≤ 150 ms; otherwise stop at C, no partial A ships. PR-0 ends with a **written go/no-go** record. **Next option if no-go (named, not built now):** a WAL-fed dirty log (logical decoding consumer) with LSN fencing — the reader reads `pg_current_wal_lsn()` at request start and waits until the consumer has passed it. Exact, O(changes), off the write path; preferred over reopening triggers.
   Depends on: none.
2. **PR-0b: narrow CTE fix(es)**, parity-tested, if the gate says so. Then re-measure. Depends on: PR-0.
3. **PR-1: generator, cacheable function, fp function, membership function, parity harness** (sweep, boundary and fan-out) in CI. No callers. Depends on: PR-0 (PR-0b if shipped).
4. **PR-2: tables, flag (default off), read protocol behind the flag, concurrency tests, fail-safe test.** Depends on: PR-1.
5. **PR-3: shadow compare (single-statement, MLQ-7 rev), reconcile cron, mismatch log, auto kill switch, dashboard.** Flag set to shadow. Depends on: PR-2.
6. **PR-4: cutover** after the criterion is met. Depends on: PR-3 plus the criterion, stated in the body.
7. **PR-5: optional cleanup.** Depends on: PR-4.

**Benchmarks (PR-2/PR-3):** 8 members × 3 tabs concurrent, lock-wait p99, fp cost with large sibling fan-out, reconcile duration, WAL per refresh.

**Acceptance = endpoint release gates in PR-3 (measured in shadow on the cache path) and PR-4 (after cutover).** These are separate from PR-0's component thresholds (MLQ-11) and are not implied by them. 1,755-lead member, warm:
- page p95 under 500 ms; badge p95 under 200 ms; facts p95 under 150 ms;
- lock-wait p99 under 1 s;
- smaller members no slower than today;
- zero confirmed mismatches;
- zero added write latency.

## 6. Risks and open questions
**Engineering:**
- Hash-basis caveats: VACUUM FULL / pg_repack / CLUSTER change ctids → spurious recompute (safe, just slower once); xid wraparound collision negligible (equality only, combined with ctid); row-lock-only touches (`SELECT … FOR UPDATE`) change xmax, not xmin → correctly no change; the hash aggregate must be order-independent (e.g. sum/xor of per-row 64-bit hashes plus count) or computed over a deterministic order.
- The fp cost may approach the classifier's own data reads. PR-0 decides, and the fallback is stopping at C (no exactness compromise).
- xmin/ctid hashing relies on DML always producing new tuple versions. It does in Postgres 17; the column sweep and the TRUNCATE/restore tests prove it holds in practice.
- The dependency map must track classifier edits. That is enforced by the generator plus the sweep, not by review.

**Product questions for Jarrad:**
- Is a 1,755-lead queue (4× the next member) intended? This does not block the work.

## Ruling outcomes
Proposed amendments were ruled in Fable review 3; results are recorded verbatim in the binding constraints (MLQ-4 rev, MLQ-7 rev, MLQ-9, MLQ-10, MLQ-11; MLQ-6/8 dormant; MLQ-2 addition and notes 4/5/6 applied).

## Changes since Astra review 1
| # | Blocker | Fix |
|---|---|---|
| 1 | Fail-open allowed wrong rows | Triggers removed; the per-row input fingerprint is verified at read time, so an unproven row is recomputed live (core change, §3 steps 4-5) |
| 2 | Cross-lead fan-out | The fp dependency map covers contact, siblings (outside the queue too), sibling messages, receipts, attempts, events and enrollments, foreign-receipt membership (lg), sequences, reparenting, bulk/replica/service-role writes (§1); fan-out tests (§4) |
| 3 | MLQ-7 race and consumed marks | No marks; compare and refresh in one snapshot (rev 4: single statement under the member lock, MLQ-9); per-member rows (§4); MLQ-7 amendment |
| 4 | `UPDATE OF` with transition tables | No triggers; note 4 amended text proposed |
| 5 | Read protocol gaps | Every mutation under the lock; state recheck after the lock; cache only for "now"; explicit `p_at` is live only; departed rows deleted; concurrency tests (§3, §4) |
| 6 | Token/alias derivation insufficient | Column-mutation semantic sweep; boundaries at exact, ±1 µs, ±1 ms and DST (§4); MLQ-4 amendment |
| NB | Unproven claims, benchmarks | Shadow overhead, compute benefit and fp cost are PR-0 measurements; benchmark list and targets in §5 |


## Changes since Fable review 3
| # | Item | Addressed in |
|---|---|---|
| 1 (blocking) | RR + in-function lock unsafe via PostgREST | MLQ-9 two-statement READ COMMITTED protocol, serve from RETURNING (§3 read protocol); shadow/reconcile same shape (§4) |
| 2 | fp bounded by heap reads; go/no-go; next option | PR-0(c) production read pattern + BUFFERS, written go/no-go, WAL-fed LSN-fenced dirty log named (§5) |
| 3 | Membership diff, rebuild only on MLQ-10 triggers | §3 steps 2–3 |
| 4 | Facts uses ofp + requested ids only | §3 step 4 |
| 5 | Sweep under every fixture suite, insert/delete on every path | §4 sweep |
| 6 | Hash-basis caveats | §6 |
| — | Rulings verbatim, dormant MLQ-6/8, applied notes, architect notes | Binding constraints |

## Proposed ruling amendments (for Fable)
None required. All four fixes sit within MLQ-9 (single statement; facts is a read-only variant that writes nothing), MLQ-10 (a `row_ofp` mismatch recomputes rows exactly when the ruled rebuild triggers fire) and MLQ-4 rev (the new indirect paths count as "dependency paths"). The rulings stand as written.

## Changes since Astra review 2
| # | Blocker | Fix |
|---|---|---|
| 1 | Sibling-message `sequence_step_runs` path (:155) missing | Added to the fp map and sweep. A full re-audit lists 10 indirect-id paths (§1 "Indirect-id paths") |
| 2 | Expiry lacked a lower bound | `computed_for_at` stored per row; serve requires `computed_for_at <= v_at < valid_until`; v_at semantics unchanged; boundary tests on cache hits plus the out-of-order case (§3 step 5, §4) |
| 3 | Partial facts refresh advanced shared state | Per-row `row_ofp`; facts never writes state or rows and serves live for any id failing conditions; an absent row counts as changed (§3 steps 4-5) |
| 4 | Outdated queue_rows_for baseline | Re-derived against 20261005121000_next_step_read_model.sql:23-81 (next_step_kind, nextStepMode, constant nextStepType); membership predicate, tasks columns and time traps re-cited; generation and parity target the current bodies (Source, §1) |
| NB | PR-0 thresholds are not endpoint gates; compute decision | Endpoint p95 targets are separate PR-3/PR-4 release gates; PR-0(e) adds pg_stat_statements, wait-event sampling and track_io_timing |
