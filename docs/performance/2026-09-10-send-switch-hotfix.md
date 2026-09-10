# Emergency Messages send → switch fix

User priority: Mel reports that replying in conversation A and then clicking conversation B reloads the whole page. Release this correction before the broader performance work. No customer messages are authorized by the report.

Base: exact deployed production `8c7053e7024433f46791eac1b186c1b7a7cf10ec`. Controller independently bound successful Production/Vercel deployment 6370837340 at September 10, 11:43:22Z to that SHA. Source confirms an explicit `router.refresh()` after a sent reply, further route refreshes on terminal outbound realtime events, and route navigation for conversation selection. This establishes whole-route React Server Component work; it does not prove a full document/browser reload occurred in Mel's session.

Depends on: none. This standalone change includes its required resource endpoints and selection code. It uses the reviewed conversation-selection slice of PR 514 at `cbf022f5a814615b7d4d1c23c33ef4bf311854ac` as an implementation basis; that exact source received Fable round-three DONE in the prior review ledger. The complete hotfix requires new independent manual and Fable review against the production base. No unreviewed PR 518 dependencies were copied. Broader instrumentation, roster, query/index, unknown-inventory redesign and migrations are excluded.

## Ownership and behavior

- `inline-reply`: Messages supplies a focused send-success callback; standalone lead detail retains its existing route-refresh fallback. An immediate in-flight guard prevents duplicate keyboard submission. Confirmed sends clear only the submitted draft; failure retains it. Protected server send, consent/quiet-hours, provider and idempotency logic are unchanged.
- `cockpit-view`, `use-conversation-selection`, `thread-detail` endpoint: native conversation selection and bounded authorized detail retrieval preserve the shell. Current-selection/generation checks discard A's late response after B. Terminal delivery/safety events refresh only detail; failure preserves display/draft and disables reply until a fresh authoritative read succeeds.
- `use-inbox-refresh`, `inbox-refresh` endpoint, list/throttle: coalesced refresh replaces known rows/counts plus Unknown/Dismissed counts without rebuilding detail. Existing authenticated count algorithms are retained, including their existing query cost and independent known/unknown reads. No count estimate or long-lived cache is introduced.
- `messages-thread`: scroll updates stay inside the Messages pane and do not move an operator who is reading older history. Standalone lead-thread behavior remains the fallback.
- Tests cover send A then switch B in both completion orders, late A response, B draft/shell identity, duplicate keyboard send, terminal outbound safety gating, coalesced events, failed refresh, stale filter responses, exact existing unknown-count classification and authenticated/no-store resources.

## Release evidence

Before initial freeze: TypeScript passed; 126 focused component tests passed, followed by the new scroll-preservation test's focused suite; eight endpoint tests passed. Remaining checks include full repository verification, production build, background Chrome proof and exact-head independent manual/Fable approval. No merge, deployment or production improvement is claimed here. Root/controller owns release ordering and admission.

Background browser proof must distinguish a synthetic component contract (mocked provider/auth/API) from authenticated application preview acceptance. No real customer send or shared desktop control is needed. After merge, verify exact deployed SHA and the owned-fixture send-A → switch-B journey; continue the seven-day latency plan separately.

At initial head `dfdebc08`, full repository verification passed (3,691 unit tests, 1,259 RTL tests, TypeScript, atomic checks and private PostgreSQL 17 rehearsal). A first temporary synthetic Chrome harness timed out before reaching the composer; that is an unverified harness, not accepted browser proof or an admitted product bug.

Independent manual review identified an Unread pin race: an A-pinned inbox response could arrive after B was selected. The follow-up binds request, cancellation and adoption to the current resource scope and selected Unread conversation, and ignores late callbacks from obsolete scopes. A selection change requests B's snapshot; ordinary All/Mine selection does not add another aggregate because those queries do not use the selected-thread exception. The new A-pinned response/late-callback regression and neighboring Cockpit tests passed (33 tests). Reviewer recheck and exact-head Fable approval remain required. Heavy checks/build/browser execution are serialized under the root's CPU/release coordination.
