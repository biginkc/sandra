# Inbox development plan

Status: revised implementation contract v2; awaiting review of this exact revision. September 13, 2026.

## 1. Outcome and boundaries

Make opening and switching conversations fast at realistic data volumes, and reduce the steps required to apply outcomes, ownership changes and replies to one or many conversations. This is an Inbox replacement alongside the current Inbox, not an Outbox rewrite.

The source baseline is e5fce2d; core reviewed paths were checked unchanged at remote main 269d44ca. Deployment, database definitions and present-day latency are not yet verified. Source evidence is in `inbox-feasibility-2026-09-13.md`; complete capability inventory is in `tmp/messages-inventory-e5fce2d/docs/research/messages-functionality-inventory-2026-09-13.md` relative to the workspace. Historical Fable architecture approval does not approve this document.

The user explicitly authorized development immediately after Fable approves this plan. No additional permission is needed to begin local implementation and isolated verification. This does not authorize real customer messaging, new service spending, or bypassing repository migration/deployment safeguards. Existing repository engineering and migration checks apply; retired orchestration does not.

### Scope contract

- Preserve individual history, contact/property/owner/phone context, delivery indicators, reply templates, single SMS, links, eligible phone action, individual appointment booking and identity resolution, and the existing New Message destination.
- Preserve search across all eligible conversations, not just loaded rows. Keep All, Unread, Needs Outcome, Assigned to me, Unassigned, existing AI escalation/disposition review, Unknown and Dismissed views and DNC/test visibility rules. Labels may clarify existing meaning, not silently expand filter membership.
- Add older-history pagination. Opening marks read; selection alone does not. Retain authoritative safety checks and show mark-read failures.
- Normal click selects only that row. Shift-click toggles individual rows. Shift-drag adds intersected rows through a rectangle; movement threshold distinguishes click/drag without a timed hold. Shift-click removes exceptions. Use an explicit Open control to inspect a conversation without replacing a group selection. Provide keyboard-accessible selection and action buttons alongside drag actions.
- Preserve selection by conversation ID across filtering/pagination and detail inspection. Show total/hidden counts and review hidden selections. New arrivals never enter an existing selection automatically. No implicit select-all across the database in this release.
- Freeze ordering during selection/drag; show new-arrival indicator. Applying the indicator retains IDs and reconciles visibility. Remove inaccessible/deleted targets with an explanation; do not silently substitute another row.
- Single/bulk outcomes, assignment/unassignment, promotion to lead, unknown dismiss/restore, reviewed replies and named saved action combinations. Appointments and identity matching remain individual.
- Outcome + assignment is first. Actual sequence enrollment is a separately gated extension, not synonymous with Needs sequence. Sequence management excluded. Apology + permanent DNC separately gated; SMS opt-out is not permanent DNC.
- No new AI recommendations or AI bulk generation. Existing AI review/correction remains, initially individually reviewed. Cross-conversation draft preservation deferred. Outcome/assignment Undo is an optional feasibility extension, not a release dependency.

## 2. Architecture decision and evidence gate (P0)

Deliverables: deployed revision/schema/index inventory, authenticated route timing breakdown, workload fixture specification, candidate comparison and signed-off numerical performance budget.

Start with bounded read-only catalog/statistics and available telemetry. Production conversation opening marks read; use authorized synthetic conversations or an isolated database for interactive measurements. No production stress workload or blanket EXPLAIN ANALYZE. Capture total/recent conversations/messages, unmatched history, long conversations, tenant skew, peak arrivals, concurrent operators and provider/backlog behavior. Redact customer data and credentials.

Measure click to first readable correct conversation and controls ready, first opens and revisits; list/search/filter times; input feedback; requests/bytes; server branch timings; database execution; browser long tasks/memory; ingestion lag and job progress. Separate historical numbers, metadata-only probes and end-to-end measurements.

Compare candidates against the SAME authorized tenant, correctness requirements, workload and command core:

1. Decoupled PostgreSQL read paths plus bounded client cache and targeted reconciliation.
2. Maintained conversation summaries plus a bounded synchronized client workset. Re-evaluate the earlier Electric/TanStack DB and Zero shortlist with current official contracts if this candidate is tested; prior recommendations are not purchase decisions.
3. A full backend replacement only if evidence shows the first two cannot meet requirements; assess migration and permission/integration parity fairly. Installed technology is not proof of suitability.

Initial implementation hypothesis: decouple reads before replacing platforms. Do not finalize a vendor or undertake projection migrations until P0 evidence identifies the needed changes. If measurement requires instrumentation, that is the first separately reviewed development increment after plan approval.

Numerical gates must be frozen before candidate performance comparisons: p50/p95/p99 first-open/revisit, selection feedback, search/filter, accepted-job acknowledgement, incoming-update lag, memory and ingestion regression. Fixture tiers: measured current volume, 3x conversation/history volume, and measured peak arrivals plus agreed headroom; include long-history and unknown-sender skew. These are proposed test tiers, not claims of actual traffic or an automatic promise of infinite capacity. If budget cannot be set or tested, performance approval remains blocked, not waived.

## 3. Fast independent Inbox reads (P1; depends P0 decision)

Owners/modules: Messages page/detail/list readers, threading guard, unknown-sender reader, message SQL and narrowly scoped shared read helpers.

- Split list, selected detail, counts and unknown groups into independently requested data. Ordinary conversation switching must not await list rebuilding, queue reads, unknown history or tab totals. Keep Outbox's existing paths and semantics.
- Side-effect-free detail reads return bounded message history and actionable context. After content is readable, explicitly mark the opened conversation read with current guards and reconcile errors. Race-safe request identity prevents a slow response for A replacing newly opened B.
- Cache only bounded recent conversation display data by org/user/context. Evict on logout/organization/access changes; refresh after reconnect and relevant mutations. Never authorize a send from cached consent or permissions.
- Paginate history using stable `(created_at,id)` ordering and list with stable server ordering/cursors. Preserve back/forward and deep links; selection remains separate from route state.
- If approved by P0, maintain tenant+conversation summary records rather than repeatedly grouping full history. Define affected-writer update/rebuild paths for incoming/outgoing messages, reads, identity merges, owner/outcome, consent, reviews, corrections/deletions and time-window expiry. Backfill, repair and compare summaries with authoritative queries before switching reads. Benchmark summary write contention and ingestion overhead.
- Scope realtime, coalesce updates and bound client buffers. Treat events as hints unless a tested replay protocol guarantees otherwise. On disconnect, overflow or missing continuity, invalidate/resnapshot authoritative data. Subscribe/buffer before snapshot and reconcile with authoritative versions to avoid snapshot races; never use a pre-commit sequence as a committed watermark. Counts may refresh separately with a visible updating state.

Acceptance: correct fast A/B/A navigation with out-of-order responses; unchanged search/filter/read/route/safety semantics; bounded browser memory and query work; evidence meets P0 budgets under arrivals. No extra background requests to unrelated Outbox data during detail switches. Existing Outbox acceptance remains green.

## 4. Selection and action workspace (P2; depends stable P1 contracts)

Owners/modules: new Inbox list/detail/action workspace behind a feature flag; shared domain types only where needed.

Implement the scope gestures, visible selection count, hidden-target review, keyboard alternatives and single-versus-group action labels. Virtualization is optional based on profiling; selection must survive unmounting rows, scrolling and pagination either way. Rectangle selection includes only rows actually intersected during the gesture; auto-scroll reveals more rows without selecting unseen database results.

Both click and drop construct the same command intent. Dropping never bypasses a required reply/DNC/sequence review. Routine metadata actions need no extra confirmation when scope is clear. Persisted backend results, not the optimistic highlight, determine completion. Keep selection after action; show exact exclusions and per-step results.

Acceptance: all selection gestures, cancel/Escape, lost pointer capture, scrolling, incoming arrivals, hidden/deleted targets and keyboard use preserve exact IDs. Opening an appointment or identity resolver remains single-target even with a group selected.

## 5. Durable outcomes, ownership and saved actions (P3; depends P2)

Reuse audited `assignLeadsBulk` logic and jobs/job_items/promotion patterns where suitable. Do not implement a loop of page actions with one refresh per item. Authoritative property versions must be advanced atomically by ALL relevant writers, including existing UI, workflow and integration paths; an Inbox-only revision counter cannot detect external edits. If universal revision coverage is unavailable, design and prove another transactional concurrency contract before claiming conflict safety.

New versioned saved-action definitions: ID, owner/org, name, schema version, allowed typed steps and referenced IDs. Default personal visibility; shared/team definitions require an explicit product decision before adding sharing. Builder supports choose steps/details, plain-language preview, save/edit/delete, and Save this combination. Editing/deleting never changes an already accepted operation. Disabled gated step types cannot be executed through stale definitions or direct requests.

Operation receipt: immutable requester/org, action-definition version, selected conversation IDs, resolved property/recipient IDs and expected revisions, accepted time, idempotency key and per-step records. Unique operation-target-step identity prevents replayed mutations. Resolve and authorize all targets server-side; deduplicate properties while retaining conversation-to-property mapping and honest counts.

Within each database mutation, lock/check expected versions, apply the domain change, persist before/after receipt and required audit, and commit together. Outcome side effects (including cleared follow-up date and superseded AI review) belong to the contract. If outcome fails, dependent assignment is skipped; if assignment fails after outcome succeeds, show partial completion and retry assignment only after checking current state. Never reapply a completed step.

Worker claims use leases/fencing; expired workers cannot commit stale receipts. Check organization membership and action permissions at execution, including after long delays. Browser closure does not cancel or restart accepted work. Results remain recoverable on reload; retention policy must be defined before migration.

Use separate typed targets for promotion and unknown sender groups. Freeze unknown-dismiss/restore message IDs at acceptance; a newly arriving unknown message remains active unless explicitly selected later. Do not let an address-only update capture later arrivals. Preserve current organization and safety guards.

Acceptance: duplicate submission, crash between steps, lost acknowledgement, concurrent owner/outcome edits, two conversations sharing one property, permission revocation, sender-group new arrival and worker replay. Prove no overwrite or duplicate effects and truthful counts. Reuse promotion's existing domain transitions without opening many pages.

## 6. Reviewed bulk replies (P4; depends P3 operations)

Prepare personalized text, explicit actual From/To route, conversation/property IDs, recipient inclusion/exclusion reasons and relevant dependency revisions. User can inspect personalization/remove recipients and confirm Send to N. Freeze approved content and recipients; selection changes do not modify them. Same phone across several conversations must not silently receive duplicate messages: surface collisions for explicit resolution and re-count before approval.

A latest-inbound/route/consent/version change invalidates the affected prepared item; show the new reply or exclusion and require renewed review for that recipient. At execution, transactionally validate dependencies and claim the send attempt against concurrent changes. Recheck authoritative permission/consent immediately before dispatch. A message arriving after a committed dispatch claim is a later event; do not promise recall or zero race across an external provider boundary.

State machine: prepared → approved → claimed → dispatch_started → provider_accepted → delivered/failed; excluded/conflict/canceled/uncertain are explicit outcomes. Persist operation-recipient-step and attempt identity before provider call; store provider reference upon acceptance. A crash or timeout after dispatch started with no definitive result becomes uncertain, never an automatic resend. Reconcile using verified provider capabilities and callbacks; if lookup/idempotency is unavailable, require deliberate resolution. Do not infer that a durable engine gives exactly-once external delivery.

Providers and Outbox integration remain unchanged in behavior. A narrow Inbox adapter may use audited shared sending primitives; do not repurpose campaign/Outbox queue semantics. No real customer traffic during implementation tests; use isolated synthetic data and provider test doubles, followed by separately authorized provider verification if required.

Acceptance: double-click, reload, worker replay, acceptance followed by database failure, delayed/duplicate/out-of-order webhook, restriction change, fresh inbound, route collision, personalization and partial failure. Show accepted/queued versus delivered honestly. Canceling reply never reverts an already applied outcome/assignment.

## 7. Gated extensions

**P5 sequence enrollment:** retain Needs sequence as existing outcome. Actual enrollment enabled only after the independent sequence workflow passes end-to-end readiness. Preview actual sequence/recipient and first scheduled action; persist enrollment ID against operation identity so replay after completion cannot reenroll. No sequence management or enrollment Undo in Inbox.

**P6 apology + DNC:** unresolved dependency, not a promised first-release feature. Specify permanent suppression policy and all sender enforcement points. Current Inbox permanent DNC control is disabled. Need durable suppression progress even if sending fails, no preexisting-DNC bypass, and explicit permitted-final-apology ordering under crash/concurrency. If this cannot be made correct, leave disabled and return the decision to the user; do not silently substitute ordinary opt-out.

**P7 Undo:** optional later increment. Authoritative versions/operation ownership, complete before/after effects and conflict checks are mandatory. Value equality cannot detect A→B→A changes. No undo of sent messages or sequence enrollment. Exclude until safety and usefulness justify implementation.

## 8. Parity, verification and rollout (P8)

Before implementation starts, copy the inventory IDs into a tracked acceptance matrix. F01–F14: preserve scope, separate selection/open, clarify filters, add older history. A01–A11: preserve domain behavior, add only agreed bulk capability, appointments individual and permanent DNC gated. A12–A13: preserve existing individual AI review/correction, no new AI suggestions. R01–R04 and remaining reply constraints: preserve routes/validation/templates and add reviewed bulk flow. U01–U08: preserve resolution individually, bulk only dismiss/restore. O01–O10: unchanged regression boundary. No unmapped inventory item may be silently retired.

Tests at appropriate layers: database constraints/atomicity and tenant isolation; job crash/replay and provider ambiguity; browser behavior/selection/partial results; measured performance at P0 fixture tiers. Playwright is supporting verification, not the development plan itself. Assert persisted outcomes as well as UI text. Use ordinary user permissions for realistic benchmarks; service-role metadata reads are not a baseline. Capture secret-safe traces and timing evidence. Run repository-required checks; failed/unrun cases remain explicit.

Rollout: new Inbox behind per-user enablement while old Inbox remains usable on the same records. Prefer additive schema and backward-compatible contracts; migrate via repository safeguards. Test an old/new user editing the same lead. Pilot with VA after automated gates, compare task steps and latency, then enable by default only after acceptance. Disable new entry point if needed; this does not undo data mutations. Accepted jobs remain resumable/inspectable regardless of interface flag, with guarded server pause/recovery if correctness is in doubt. Do not drop additive tables or rollback schema destructively while jobs are active.

## Definition of development-ready

Fable approves the exact written plan; user scope is preserved; P0 measurement/access work is concrete; unresolved features remain visibly gated. The user authorizes beginning the first implementation increment immediately upon Fable approval. Plan approval does not establish measured performance, provider correctness, a final vendor selection or completed deployment acceptance. Final architecture selection occurs at P0's evidence gate. First planned development increment: timing instrumentation and independent conversation-read contract, followed by P1 implementation according to results.


## Review corrections and entry record (v2)

This section resolves ambiguities in earlier sections and governs where wording conflicts.

- P0 exits with a versioned decision record: baseline evidence, user task-derived numerical budgets signed off by the user, exact synthetic/isolated workload, candidate results, selected read design, dependency list and residual risks. Prototype candidate 1 first; prototype candidate 2 only if it misses frozen budgets or fails correctness. Assess candidate 3 on paper unless both fail; further funded experiments need a bounded proposal. Do not preselect a production vendor. Candidate-neutral contract and timing instrumentation may start before this record; projection tables and vendor-specific code may not.
- Budget sign-off is an input to candidate comparison, not a prerequisite to collecting baseline observations. Recommend explicit target numbers from task needs and representative evidence; do not derive acceptable speed merely from existing slowness. No production interactive comparison; approved test fixtures must use synthetic/isolated data.
- P1's new read paths are additive and consumed by the flagged new Inbox. Existing Inbox/Outbox remain behaviorally unchanged. Initial instrumentation alone may touch existing readers. Name any later shared helper modification in its PR and prove BOTH old Inbox and Outbox regression coverage. Separate search request/cursor/budget from detail.
- Mark-read occurs only after the correct conversation detail actually rendered for an explicit open. Superseded responses that never rendered must not mark a thread read. Selection alone never marks read.
- Selection/open semantics are an explicit user-approved decision, not accidental wording: normal click selects one row; explicit Open inspects without disturbing a selected group. Preserve this contract in the initial implementation. Measure real task interactions in the pilot. If a combined single-click select-and-open behavior is desirable, bring that product change back to the user rather than silently overriding the agreed rule.
- P3 default: transactionally lock target, compare specifically affected fields and relevant safety predicates with captured expected state, perform mutation and persist receipt atomically. This detects current-state conflicts, not every intervening A-to-B-to-A edit; do not label it a universal version guarantee. Include follow_up_at in an outcome mutation's compared/receipted fields. If exact version detection is required for a particular command, that command stays gated until all relevant writers have coverage. Universal revision work is NOT a prerequisite to ordinary outcome/assignment. P7 Undo DOES require stronger revision/operation ownership checks and remains excluded otherwise. P4 inbound/route/consent validity is separately fenced at send claim, not inferred from P3 field equality.
- The disabled permanent DNC control is a VERIFIED EXISTING SOURCE FACT (inventory A07), not a proposed removal. Keep existing working SMS opt-out and its restrictions; permanent DNC remains additional gated work.
- Validate saved-action references against organization and eligible entities when saved and again at execution. Confirm job lease/fencing support or implement it in receipt claims before enabling workers.
- Set a server-enforced initial bulk recipient cap during P0 from provider limits and user workflow; record it with the budget. No customer sends or new service purchases are authorized by this planning review.
- Open PR dependency audit found #514 independent thread loading, #518 scoped refreshes/performance instrumentation, #521 reply/switch stability, and #418 unrelated page work removal. These are open drafts, not validated main dependencies. Read their evidence and establish overlap before changing those paths. Do not copy unreviewed branch code, merge another owner's branch, or assume old Fable approval validates their latest heads. An implementation reusing an unmerged validated dependency must be stacked and declare it under repository rules. Independent measurement/fixtures and documented contracts can proceed while overlap is resolved. Existing PRs' current acceptance gaps must remain visible, not inherited as passing proof.
