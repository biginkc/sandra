# My Leads manual review — deployment readiness

Reviewed Sandra base 8c7053e7 and Jitter base 2c00aafa, initially published as Sandra a8321c99 / Jitter d878f2a. Final fix heads and CI are recorded in DEPLOYMENT-READINESS.md. All lanes used built-in agents; no Sandra orchestration or external Claude session was involved.

## Confirmed findings and disposition

| Finding | Evidence / user impact | Disposition |
| --- | --- | --- |
| Custom range hides its own date controls | Selecting custom sends empty dates, clears the snapshot, and removes the inputs needed to recover. | Fixed: preserve controls for incomplete dates, validate completed ranges, guard foreground refresh; RTL and browser regression pass. |
| Badge ignores refreshed server count | State initialized from props does not accept later layout counts after workflow changes. | Fixed: synchronize new initialCount; RTL passes. |
| Form errors lack accessible associations | Required fields show error text without aria-describedby pointing to it. | Fixed: stable error IDs across the four dialogs; focused RTL passes. |
| Durable seller-event recovery can lose payload | A pending sibling can be stored before parent result persistence, but recovery originally reads payload only from parent. A worker restart in that interval loses the event. | Fixed: event payload is stored in the sibling, preserved during settlement, and recovered without parent result; unchanged-snapshot interruption regression passed. |
| Launch apply re-queries a changing cohort | Later queries can include a new assignment after the preview fingerprint was validated. | Fixed: one captured cohort drives fingerprints, counts, locks and apply writes; deterministic concurrent assignment and rollback proof passed. |

## Deferred, nonblocking observations

- Coach indexing is scheduled before acquisition binding; a binding failure can leave an unused ownership row. No call is placed. Deferred small cleanup; not expanded into this feature task.
- Trusted internal call evidence does not impose a future-time skew bound. The producer supplies accepted-create timestamps; no normal-use failure was demonstrated. A clock-skew policy is not invented here.
- Additional dashboard roster/badge requests may affect latency. No measured regression; no architecture change.
- Fallow reports unused standalone scripts/configs, compatibility exports/types, complexity, and duplicate groups. CLI entrypoints are intentional, overlapping unit/RTL tests cover different layers, and no concrete failure was established by these style/static-analysis leads. No bulk cleanup.

## Coverage

- Data lane: all 13 acquisition migrations, My Leads library/server commands, direct-RPC scope, CAS/idempotency, assignments, timers, attribution, launch and rollback, and verification scripts.
- Calling lane: all Jitter changed files, Sandra receiver/binding/call flow, auth/HMAC, accepted seller-create identity, durable retries, legacy calls, DNC, and appointment action integration.
- UI lane: changed page/components/layout/sidebar/adapters/client types, dialogs, pagination, keyboard/narrow display, RTL/unit/browser configs and test duplication.
- Root: every changed planning/research/evidence document, release configuration and branch guards, manifests, secret-pattern scan, CI and local outcome proofs; verified accepted findings against source before assigning fixes.

Primary references checked: PostgreSQL transaction isolation, explicit locking and CREATE FUNCTION security; Supabase database functions/RLS; Twilio Call resource and Telnyx outbound call creation; installed Next docs; Vercel Git configuration; Railway PR environments/API. Links:
- https://www.postgresql.org/docs/current/transaction-iso.html
- https://www.postgresql.org/docs/current/explicit-locking.html
- https://www.postgresql.org/docs/current/sql-createfunction.html
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/database/functions
- https://www.twilio.com/docs/voice/api/call-resource
- https://developers.telnyx.com/api-reference/texml-rest-commands/initiate-an-outbound-call
- https://vercel.com/docs/project-configuration/git-configuration
- https://docs.railway.com/guides/preview-deployments-with-pr-environments

## Review limits

Human product review can add judgment about wording and workflow feel: /my-leads, rep and owner views, custom reporting dates, desktop and narrow layouts, attempt/offer/contract/handoff dialogs. Automated local browser proof covers these functional flows; no human acceptance or live provider parity is claimed. 1Password mappings remain unverified because its authorization prompt was dismissed. Source scans found no committed key/token literals. Production deployment, migration application, live calls and real cohort initialization are intentionally reserved for separately authorized release.
