# T2 parity case expansion and genuine gaps

Source-only expansion of all 50 existing acceptance IDs into `t2-parity-cases.csv`, preserving ID, capability and assigned phase. Current worktree baseline `4c01abe4` (verify full HEAD with git when integrating; concurrent work may advance it). No new taxonomy, feature IDs or acceptance pass claims. Every case supplies a concrete existing source path/line, expected new behavior and distinct test scenario. All new-architecture tests remain **Not run**; a source-verified status does not mean implemented or runtime-verified.

## Resolved distinctions

- A04: Follow up is `nurture` and clears `follow_up_at`; no scheduled reminder is created.
- A05: Needs sequence is an outcome only. This expansion adds no sequence enrollment implementation.
- A07: Permanent DNC remains gated/unavailable. No executable apology+DNC feature is introduced.
- A09/A12: Appointment booking and existing AI review confirmation remain individual; no bulk extension or new AI recommendation capability.
- F09: Existing read mutation filters exact conversation and organization. Linked properties are lock guards, not a broader set of read targets. New captured boundary excludes later arrivals and acknowledges only the rendered detail response.
- U04: Current `createContactFromUnknown` explicitly creates property `status: new_lead` (`src/lib/messages/triage.ts:181`). This was resolved by inspecting implementation; it is not an open outcome-taxonomy question.
- R05: Preserve draft during temporary suspension of the same mounted composer. Cross-conversation draft storage remains deferred.
- O01–O10: Regression cases only, exercising existing Outbox behavior with new capture enabled; no Outbox redesign, cadence changes or altered send semantics.

## Actual open decisions and implementation gaps

1. **Unknown history scope, U01.** `messages/actions.ts:437` fetches SMS by from_address, oldest first, limit200; it does not represent complete bidirectional history. Keep that limitation explicit while assessing any intended parity improvement. It also relies on database visibility rather than explicitly resolving one org inside this helper; include multi-org sender collision coverage when constructing the new typed route. Do not silently label it complete conversation history.
2. **Unknown dismiss/restore scope, U05/U06.** `messages/triage.ts:421,441` filters from_address, null contact and dismissal state without channel/direction predicates. The visible list is unmatched inbound SMS. The approved bulk design freezes exact IDs, but its eligibility rule must be explicit: reproduce that broad legacy scope or intentionally narrow it to displayed unknown SMS. This needs a recorded decision/test, not a guessed predicate.
3. **History cursor and ordering, F08.** Current detail query orders created_at descending and limits100; new older-history loading and deterministic tie-break/cursor behavior are approved work, not an existing tested contract. Include equal timestamps, deletion between page requests and pending review source older than the first page.
4. **Workset/expiry behavior, F06.** Stable selected IDs, limited subscription size, incoming-message row stability and workset replacement are new architecture contracts. Test full-volume cold/warm behavior; the local selection engine does not prove projection expiry or exact filter membership.
5. **Opt-out partial effects, A06.** Existing outcome/contact/consent/enrollment-pause effects span calls. Per-step receipts and safe recovery must faithfully report committed versus unfinished effects. No test may pretend the old action was atomic or lift DNC through a generic retry.
6. **Templates, R02.** Available organization templates were not retrieved. Use explicit synthetic variables/content; classify missing variable handling against current rendering and the approved bulk preview. Do not invent business template names/categories as production facts.
7. **Delivery execution, R03/R04.** Route restrictions, recipient de-duplication and provider ambiguity require actual adapter tests with a controlled stub. No source-only case certifies the provider's idempotency support or guarantees a network-timeout retry is safe.

## Recommended execution order

T2 source/projection fixtures first: F02–F06/F08–F11/U01 and exact unknown eligibility. Then T3 interaction cases: selection versus Open, stale responses, hidden selections and history paging. T4 mutations: existing outcomes, owner changes, individual qualification/appointment/review/resolution and frozen dismiss/restore IDs. T5 replies: route/content preview, same-mounted draft restrictions and durable attempt outcomes. T6 runs the ten existing Outbox regression cases unchanged.

Use database assertions for persisted effects/identity, adapter tests for failure boundaries and browser tests for actual interaction. Do not substitute one generic render/smoke test for the 50 distinct cases. Relevant existing tests can be reused, but new projection and command paths still need their own evidence.

## Verification of this artifact

Checked exact ID set against the parent CSV: 50 rows, 50 unique IDs, none added or missing; source paths and referenced line positions exist. No database access, credentials or test execution occurred during this inventory task. Any apparent UI wording change is a proposal/approved refinement, not a claim current code already implements it.

## Root integration decision: new bulk unknown eligibility

For the new Inbox bulk dismiss/restore path, capture only currently authorized,
unmatched inbound SMS message IDs in the selected sender group and applicable
dismissal state. This follows the user's Inbox-only boundary and the displayed
unknown list. Do not reuse the old broad from-address UPDATE for a bulk action.
New arrivals after capture are not included. Another organization, channel,
direction or newly resolved contact is never pulled into the accepted item set.
Recheck eligibility under the execution contract and report excluded IDs.

The existing individual helper is not changed by this decision. Its broader
legacy behavior is a separate parity finding, not authorization to modify Outbox
or other channels. U05/U06 must explicitly test the narrowed new bulk operation
against mixed-channel/direction fixtures and concurrent contact resolution.
