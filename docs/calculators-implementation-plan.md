# Acquisitions Calculators: implementation plan

Status: implementation authorized September 16, 2026 following feasibility review of `Offer Calculator (standalone).html`. Production release is requested after verification.

Latest specification: listing percentage starts at 90%, locked in the UI, with a lock icon to unlock/edit/relock. The stored input drives the unchanged worksheet formula. Commission remains fixed at 4%. Blanks count as zero and show nonblocking guidance. The existing dashboard shell remains unchanged.

## Scope and fixed requirements

- Add Calculators to the Acquisitions experience in Sandra.
- Reproduce JT's original worksheet's 11 working formulas exactly. Its percentages, commission base, expenses, and program multipliers are settled requirements.
- Explain usage through the training-aligned user guide.
- Save each completed calculation against a lead and create its activity timeline entry.
- Preserve the original inputs and results when revisiting a saved calculation.
- Record the negotiated/proposed offer separately from calculated anchors.
- Assess future mockups for feasibility without prescribing appearance.

The user has authorized implementation and production deployment through Sandra's established workflow. Saving a calculation does not authorize sending offers or initiating e-signature actions.

## Research baseline

Reviewed current remote main at `591a0ed2484fb4d8da399976522b64ebdbd09ce5`, fetched September 16, 2026. The original local checkout was on a June branch, so research moved to this isolated worktree before drawing conclusions. No application files or production data were changed.

Open PRs were inspected for potential dependencies. No calculator-specific PR was identified. The proposed implementation can target the reviewed main baseline; recheck dependencies before creating a PR, especially if mockups introduce coach, calling, or inbox integration.

## Checklist

- [x] Extract exact worksheet formulas and inspect training explanations.
- [x] Verify a standalone translation against six recalculated worksheet scenarios.
- [x] Locate current source and isolate the research checkout.
- [x] Research lead storage, existing offer actions, and event architecture.
- [x] Complete consolidated route, authorization, and test recommendations.
- [x] Assess supplied standalone HTML: feasible with existing shell and new lead-scoped persistence.
- [ ] Implement approved workspace, permissions, lead entry points, versions, and timeline.
- [ ] Verify the actual implementation against worksheet and workflow fixtures.

## Architecture findings

### Route, navigation, and access

Proposed modules (these do not yet exist):

- `src/app/(dashboard)/calculators/page.tsx`: authenticated entry and authorized lead context.
- `src/app/(dashboard)/calculators/client.tsx`: inputs, results, and completion behavior based on the eventual mockups.
- `src/app/(dashboard)/calculators/actions.ts`: lead lookup, completion, saved record retrieval, and revisions.
- `src/lib/calculators/closr-v1.ts`: shared pure equations.
- `src/lib/calculators/types.ts`: input/output and snapshot contracts.
- `src/lib/calculators/closr-v1.test.ts`: worksheet-derived expected results.

The sidebar currently contains flat navigation items, not an explicit Acquisitions group (`src/components/dashboard-sidebar.tsx:54`). Both desktop and mobile use the same visible-item logic (`:69`, `:90`, `:142`). Integrate the requested Acquisitions location with the mockups rather than assuming a group already exists.

Workspace and save access require active Acquisitions membership, including for owners, with the organization's workflow enabled. Enforce this in navigation, the server page, server actions and the transactional save RPC. Owners who belong to Acquisitions may calculate for any eligible lead; other acquisition members may calculate for assigned leads. Saved calculations remain readable by active same-organization members with existing lead access, through a separate read-only lead route. Read access does not grant workspace or revision-creation access.

Support entry with an existing property ID and entry through an authorized lead chooser. Revalidate membership, organization, property eligibility, and assignment on save. The generic message address-search action belongs to unknown-sender matching and is not a calculator authorization boundary (`src/app/(dashboard)/messages/actions.ts:295`).

### Lead identity and existing offers

Sandra's lead identity is `properties.id`; lead detail loads that record in `src/app/(dashboard)/leads/[id]/page.tsx:128`. Existing property valuation fields are current attributes, not a calculation history (`supabase/migrations/001_initial.sql:164`).

The existing `acquisition_offers` table records actual offers. Its command changes the property/queue to `offer_sent`. Saving a calculation must not call it. See `supabase/migrations/20260912090200_acquisition_attempt_offer_facts.sql:72`, `src/lib/my-leads/workflow-actions.ts:118`, and `supabase/migrations/20260912120000_acquisition_workflow_commands.sql:430`.

Calculation saving must not increment offers-sent metrics, change lead stage, create an offer follow-up task, or initiate e-signature. E-sign already has an `offer_price` field, including for novation packets (`src/lib/esign/contracts.ts:28` and `:44`), but automatic transfer/sending is outside this scope.

### Store immutable calculation snapshots

Proposed new table: `offer_calculations`, separate from sent offers.

| Data | Purpose |
|---|---|
| Calculation ID, org ID, property ID | Durable identity and tenant-safe lead attachment |
| Author, creation timestamp | Who completed the analysis and when |
| Formula/schema version and worksheet checksum | Traceable math and input interpretation |
| Inputs and all working outputs | Reopen the original analysis without recomputing history |
| Selected approach and program | Preserve financial and seller-term choices separately |
| Actual proposed offer and terms | Distinguish negotiation from calculated anchors |
| Parent revision and series ID | Preserve prior calculations during revision |
| Idempotency key and request hash | Safe retry after a lost response or double click |
| Property identity at save time | Optional historical address context if required by mockups |

Use composite property/org and revision/org/property relationships so a record cannot attach to another tenant or lead. Existing offers demonstrate composite ownership constraints (`20260912090200_acquisition_attempt_offer_facts.sql:89`). Do not store all intermediate amounts as integer cents: the worksheet retains fractional cents until display.

### Shared calculation module

Implement one pure TypeScript calculation module used by the client preview and trusted server save. Keep input mapping, equations, and output identities explicit. The server recomputes from inputs; browser-submitted calculated outputs are not authoritative.

Preserve the exact 4%, 70%, 85%, 75%, and 67% constants and the $40k/$30k/$20k/$10k fee tiers. Do not substitute introductory training shortcuts. Preserve blanks where meaningful in the input snapshot and reproduce the worksheet's numeric treatment. Do not clamp negative answers or round intermediate outputs.

Preserve operation order too, including investor price `E26 = E24 + 10000`, rather than algebraically simplifying it. Percentage input formatting must convert 90% to the worksheet multiplier 0.9.

The pre-existing B16 broken reference has no numerical output. Keep it in the source audit, exclude it from successful calculator results, and do not invent a replacement.

### Atomic completion and timeline event

Save the snapshot and append its event in a single database transaction. Existing acquisition commands demonstrate transactional mutations and event writes (`20260912120000_acquisition_workflow_commands.sql:98`). A calculation without its timeline entry, or an event without its calculation, is a failed save.

Use a stable completion-request ID. Identical retry returns the original result; reuse with a changed payload fails. The existing acquisition receipt pattern checks hashes and actors (`20260912120000_acquisition_workflow_commands.sql:44`).

Store full inputs/results in the snapshot and a small summary plus calculation identity in the event. Existing `lead_events` has composite lead/org references, a source identity uniqueness constraint, append-only access, and realtime publication (`20260825170000_lead_events_ledger.sql:7–57`).

The existing acquisition-history reader aggregates attempts/offers (`20260913230000_lead_acquisition_history.sql:15`). Do not also synthesize the same calculator event through that reader and accidentally show it twice.

**Trust boundary:** use an authenticated server action plus a service-role-only atomic RPC. The browser submits inputs, lead/revision identity, selected approach/program, proposed offer/terms, and retry key. The server derives the actor and formula version, validates inputs, and recomputes all results using the shared module. It passes canonical data to the restricted RPC. Browser roles cannot directly write snapshots or execute this RPC.

The RPC must authorize the explicitly passed server-derived actor, because service-role calls do not retain end-user `auth.uid()`. Recheck active membership and property/revision eligibility inside the transaction to handle revoked access or reassignment. Existing e-sign code demonstrates this pattern: `src/lib/esign/actions.ts:305`, `supabase/migrations/20260902120100_esign_atomic_disconnect_state.sql:423` and `:533`. Membership resolution is in `src/lib/auth/require-org-membership.ts:56`. SQL owns authorization and transaction integrity; it does not duplicate the financial equations.

Do not use `recordLeadEvent` after a separate snapshot insert: its error handling intentionally swallows ledger failures (`src/lib/events/index.ts:83`, `:159`), which cannot meet atomic-completion requirements.

### Timeline and saved-record reading

Add an explicit event type such as `calculation_saved`, source type `offer_calculation`, and source ID equal to the saved snapshot UUID. Include a validated `calculation_id` and concise summary in the payload.

Update the event taxonomy in `src/lib/events/index.ts:6`, event renderer in `src/app/(dashboard)/leads/[id]/lead-events.tsx:127`, and the reopen action in the unified activity presentation (`lead-activity.tsx:393`). Unknown events currently fall back to generic text (`lead-events.tsx:309`), and event pills are not yet links. The current event select omits `source_id`, so use the validated payload ID or deliberately extend its types/selects.

Reuse existing realtime reconciliation and ID deduplication (`lead-events.tsx:74`, `:94`). Preserve the sent-offer-specific deduplication in `lead-activity.tsx:473` by giving calculator events their own identity. The lead page loads only the newest 200 ledger events (`page.tsx:410`); use a separate paginated calculation list/detail read so old calculations remain accessible beyond that window.

### Lifecycle behavior

- Read saved snapshots rather than silently recomputing with updated property values or future formulas.
- Revision saves create new records. For concurrent edits, allow explicitly distinguishable revisions rather than claiming an old view is automatically the latest.
- Lead merging must preserve snapshot history. Existing merge logic repoints `lead_events` before removing the duplicate (`20260825170000_lead_events_ledger.sql:75`); include the new records in the corresponding maintenance path.
- The later merge wrapper also handles e-sign and lead files (`20260829194500_esign_foundation.sql:3287`). Extend the current complete merge chain, not an obsolete earlier function body.
- Follow existing soft-delete and active-membership behavior in read/write endpoints.
- A calculated result does not authorize seller contact or bypass DNC restrictions.

## Implementation sequence

1. **Calculation module and fixtures.** Add the pure engine, cell-to-field mapping, and versioned worksheet fixtures. Demonstrate parity before connecting persistence.
2. **Persistence and authorization.** Add snapshot schema, access controls, transactional completion command, and list/detail reads. Rehearse migrations through the repository's established workflow.
3. **Calculator route and help.** Integrate the approved mockups, lead context, inputs/results, user guide, completion action, and saved-detail behavior.
4. **Timeline integration.** Add calculator event interpretation and reopen behavior with cache/realtime refresh. Verify exactly one event per completed save.
5. **Workflow verification.** Run arithmetic, database, component, and Playwright checks. Review the actual experience against mockups.

Implementation is in progress on `codex/closr-calculators-20260916`. All changes are isolated in this worktree.

## Verification contract

### Worksheet parity

The standalone harness has six scenarios and 66 output comparisons. All matched to the cent; maximum raw numerical difference was $0.00000000003. Recalculation used LibreOffice, not live Excel or Google Sheets. The actual Sandra module must run these fixtures; prior harness success does not establish app correctness.

Compare all 11 outputs, confirm identical inputs, retain full calculation precision, and report raw differences as well as formatted amounts. Include the original snapshot, varied values for every expense, decimals, zero repairs, blank optional repairs, and negative outputs. Add a meaningful half-cent formatting boundary test because matching arithmetic alone does not prove matching displayed rounding.

Expected fixture values must come from the recalculated worksheet caches / `worksheet_recalculated` CSV column, not the earlier JavaScript translation. This keeps the worksheet as the independent oracle. Preserve the observed raw comparison threshold of $0.000000001 and check displayed currency independently; do not describe approximate binary equality as bit-for-bit equality.

### Persistence and permissions

- Cross-org lead and revision spoofing fail.
- Inactive/expired/non-permitted users cannot save or reopen restricted records.
- Repeated completion returns one calculation and one event.
- Two concurrent requests with the same completion key return the same snapshot identity and leave exactly one event; verify this with concurrent database-backed requests, not only sequential retries.
- Conflicting use of an idempotency key fails.
- Event insertion failure rolls back the snapshot.
- Tampered browser outputs are ignored and recomputed.
- Direct authenticated/anonymous RPC writes fail; spoofed actor/version/checksum fields are rejected or ignored. Revocation between server validation and the database transaction prevents saving.
- Saved history survives revised inputs, lead merges, and changes to source property values.
- Completion leaves offer status, sent-offer counts, follow-ups, and e-sign state unchanged.

### Browser behavior

Playwright should prove select lead → enter inputs → compare results → complete → find timeline entry → reopen → revise → reopen original. Cover retries, validation, failed saves, permission denial, and lead context changes during an in-flight request.

Use synthetic tests for deterministic input/interaction behavior and a disposable database lane for real persistence/authorization. Mocked browser responses cannot prove transaction or row-level-security behavior. Follow the current CI requirements in `package.json` and `.github/workflows/verify.yml:30–46`; do not run existing destructive/reset-heavy suites against a shared or production database.

Useful existing test patterns:

- `src/lib/events/index.test.ts:213`: intentionally swallowed ledger errors.
- `src/app/(dashboard)/leads/[id]/lead-events.test.tsx:564`: realtime reconciliation/deduplication.
- `src/app/(dashboard)/leads/[id]/lead-activity.test.ts:270`: sent-offer versus generic event deduplication.
- `supabase/migrations/20260825170000_lead_events_ledger.integration.test.ts:93`: ledger grants, source identity, and tenant isolation.
- `e2e/synthetic/my-leads-metrics.spec.ts:9`: real component synthetic browser harness.
- `playwright.my-leads-local.config.ts:10` and `e2e/my-leads.local.spec.ts:38`: guarded loopback fixture pattern. Do not assume historical temporary fixtures still exist.

No application tests, browser sessions, or database test suites were executed during this research. Existing worksheet-harness results are the only completed numeric verification. Future database migration execution must use the existing test-to-production workflow, which pins the tested commit (`.github/workflows/db-migrate-prod.yml:100`, `:108`, `:127`).

## Mockup feasibility assessment

When mockups arrive, classify each requested behavior as supported by existing code, requiring new code/schema, or needing clarification. Evaluate:

- Whether every worksheet input and output is represented without changing the math.
- Whether calculated anchors, proposed offer, selected approach, and program remain distinct.
- Lead selection/context, incomplete inputs, loading, failed save, retry, and successful completion.
- Reopening and revising historical calculations.
- Timeline record access and permissions.
- Any implied status transitions, auto-sending, contract generation, or other extra scope.
- Numeric formatting and accessible interaction behavior.

Return a behavior-by-behavior feasibility table, concrete implementation impacts, and any necessary scope decisions. Do not dictate colors, layout, typography, or visual style in advance.
