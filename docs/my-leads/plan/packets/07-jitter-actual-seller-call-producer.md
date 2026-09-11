# Packet 07 — Jitter actual seller-call producer

**Depends on:** P08

Read [PRD](../../PRD.md), [CONTRACTS](../../CONTRACTS.md), [technical plan](../../TECHNICAL-PLAN.md) and repository AGENTS first. These are future implementation instructions, not a test-result receipt.

## Owned files

- `Jitter: src/mvp/product-execution.ts and/or src/telephony/telnyx-provider.ts (bounded existing seller-create success seam)`
- `Jitter: src/contracts/side-effects.ts, src/telephony/product-executor.ts, src/bridge/sandra-api-client.ts (additive event type, executor and authenticated delivery adapter)`
- `Jitter: tests/sandra-call-started-writeback.test.ts (new)`
- `docs/my-leads/plan/CALL-EVIDENCE-RECEIPT.md (new joint contract receipt)`

New paths and migration names are proposed. `<new>` means a fresh ordered migration timestamp assigned by the schema owner; never edit a historical migration. You are not alone in the repository: preserve other edits and use the assigned worktree.

## Steps

1. Use separate Jitter-owned worktree and AGENTS. Verify current remote/deployed parity from P00, then identify exact durable seller-create CallSid success or authenticated initiated callback.
2. Bind event to original Sandra callToken/org/property/actor/episode using existing context. Never use start-call, operator connect or RTC acceptance as seller initiation.
3. Reuse existing signed durable delivery/retry facilities to emit ActualSellerCallStarted v1 to P08 receiver. At researched Jitter main, `sandra.writeback` and `sandra.item_report` share accounting retry/dead-letter handling in `src/mvp/product-execution.ts`; add a narrow `sandra.call_started` sibling with the same durability and pause-safe accounting behavior if no existing payload supplies the contract. Update the side-effect union, executor and signed client together. Do not repurpose a final outcome writeback or change call actuation. Revalidate these seams at P00.
4. Test provider response lost, duplicate event, operator-leg event rejection and failure to persist Sandra evidence without redial. Preserve all dial/bridge/termination behavior. Deploy receiver before producer.

## Verification

From the assigned Jitter worktree (Node ≥22 at researched main), revalidate these scripts in P00:

- `npm run test -- tests/sandra-call-started-writeback.test.ts tests/sandra-api-client-signature.test.ts`
- `npm run typecheck:all`

Run the authenticated producer-to-receiver contract fixture under an admitted integration target; no real calls in unit proof. Mock outbound provider and Sandra network calls, and retain the existing no-egress test setup.

Commands naming proposed tests run only after those tests exist. Record discovered counts; no-tests-found is not a pass. All integration/browser/provider operations require the applicable admission in [TEST-AND-RELEASE](../TEST-AND-RELEASE.md).

## Done when

Receipt binds verified producer path/version to seller call ID and occurrence timestamp, stable token and receiver fixture; setup/operator events cannot stop clock. Deployed end-to-end proof remains release-gated.

## Boundaries

Explicit cross-repository ownership/dependency: Luna Sandra UI owner must not edit Jitter opportunistically. If current deployed producer lacks this evidence, this bounded extension is required; no UI timestamp fallback.

## Return to coordinator

Exact head/base/dirty paths, what changed, contract deviations, test commands and actual results, unrun checks with reasons, dependencies, migration/provider effects, and readiness for the next packet. Do not claim deployed completion from local tests.
