# Add My Leads Acquisitions workspace with independent queue and call evidence

My Leads gives Acquisitions reps a focused five-section workspace over existing leads. It keeps queue state independent of the Leads board, shares only explicit milestones, and supports motivation, offer follow-up, contract recording, deliberate archive, and Needs sequence handoff without automatic tasks or enrollment.

The change adds scoped transactional RPCs, idempotent commands, assignment and performer attribution, working-time warnings, independently paginated sections, owner controls, and an authenticated seller-call receiver. The feature defaults off. Genuine pre-feature leads can be previewed and initialized without invented activity or first-call timing, with stale-preview rejection and rollback.

Validation: 3,778 unit tests, 1,268 RTL tests, production build, full 216-baseline + 13-feature SQL replay, nine serial browser acceptance journeys, and real signed loopback receiver transport passed. Private PostgreSQL tests cover concurrency, authorization, late/duplicate evidence, attribution, and launch rollback. See ACCEPTANCE-RECEIPT.md and SOURCE-MANIFEST.json for exact scope and limitations.

Release requires receiver-before-producer ordering, native CI/migration/deployment checks, live provider parity, and a reviewed Maria cohort before feature enablement. No production rollout is included in this local candidate. The user authorizes temporary CI identities and their cleanup. Deployment, including previews, merging, shared migrations, real calls, and production cohort initialization are excluded from this task.

Depends on: none (within Sandra). The separately reviewed Jitter producer must be released after this receiver.

Manual review: three built-in review lanes completed. Confirmed fixes cover custom date entry, refreshed badge counts, accessible field errors, and an exact captured launch cohort. Jitter separately fixes durable event recovery. Minor coach-index cleanup and unproven timestamp/performance hardening are deferred; no feature expansion. See MANUAL-REVIEW.md and DEPLOYMENT-READINESS.md.

This PR intentionally has no preview deployment. Hosted migration application, live provider parity, external calendar synchronization, Maria cohort application, and feature enablement are release-only checks and have not been performed. No merge is authorized.
