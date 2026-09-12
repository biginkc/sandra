# Deliver durable actual seller-call evidence to Sandra

Persist Sandra acquisition context before softphone initiation and emit signed `seller_call_create_succeeded` evidence only after the seller leg is created. Durable delivery retries reuse the event and never redial. Legacy calls without acquisition context preserve their previous behavior; tracked writeback retains the original actor, organization, property, and provider identity.

Validation: 245 focused tests and typecheck passed; the committed relevant provisioning migration plus acquisition-context migration passed a private PostgreSQL 17 rehearsal, including replay, null/omitted context, actor guard, migration rerun, and row-lock contention. This is not a full empty-database Jitter migration replay or live provider parity proof.

Deploy the compatible Sandra receiver before enabling this producer. See docs/my-leads/plan/CALL-EVIDENCE-RECEIPT.md. Live deployment, provider parity, and coordinated rollout remain pending.

Depends on: the Sandra My Leads receiver for release ordering (cross-repository; no unmerged Jitter code dependency). Do not enable/release the producer first. No deployment, preview, merge, shared migration, or real call is authorized.

Manual review completed with a bounded durability fix: sibling event payload survives parent-result interruption and is recovered without another seller create. Executor suite 140/140 and typechecks passed; final exact-state interruption regression passed. The initial full CI run's unchanged browser-audio timing failure passed on focused rerun and full CI rerun without an unrelated product patch. Final CI is recorded on the PR.
