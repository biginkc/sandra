# Inbox production installation candidate

This is an executable candidate under review, outside `supabase/migrations`. It has not been applied to production. Both the server feature flag and a new database serving gate remain disabled. Compiling this package does not run SQL or create infrastructure.

## Current progress

- [x] Pin 20 reviewed source components and their exact hashes in components.json.
- [x] Compile stable `inbox_*` private namespaces and unchanged public RPC names.
- [x] Separate seven canonical-table indexes into concurrent, resumable statements.
- [x] Add bounded baseline, expiry, retention and durable worker-step primitives.
- [x] Establish source-compatible Auth trigger installation and rollback with a separate role-equivalent fixture proof (PR577).
- [x] Fresh real GoTrue Auth bootstrap and canonical app replay; actual candidate install, late-failure rollback probe, seven concurrent indexes and disabled serving gate.
- [x] Canonical message capture through durable worker, assignment/outcome fanout, facets and timestamp-age removal smoke.
- [x] Hash-pinned PR579 read/history companion installed; six bodies and authenticated-only public grants verified.
- [x] Validate known/unknown read/history companion catalog, bounded retention and actual held-lock behavior.
- [ ] Validate final external operations APIs and continuously supervised worker hosting against the same candidate.
- [ ] Measure installation locks, write amplification, worker catch-up and schema equivalence before migration promotion.

## Executable package

`build.py` checks source hashes, removes only the exact marked fixture guards and outer transaction envelopes, translates private namespaces, and inserts a database serving gate into the canonical bridge authorization function. Unknown source changes stop compilation. It emits `generated/install-candidate.sql`, seven standalone concurrent-index files, and `generated/rollback-serving.sql`. The historical unbounded queue seed is deliberately removed: bounded jobs perform baseline initialization instead. `inbox_bridge.summaries` uses REPLICA IDENTITY FULL; no maintained JSON, workset, policy or Auth tables are exposed to Electric.

`rehearse-bootstrap.py --resume-full-auth` only accepts the separately marked `sandra_inbox_install_20260913` database in the fixed guarded T2 container. The frontend owner first installs real GoTrue Auth there. This runner refuses missing or subset Auth, preserves its schema/ownership, and replays pinned non-Auth vendor prerequisites and canonical application migrations with an atomic per-source hash ledger. It never creates or resets the original T2 database.

`rehearse-install.py --owned-fixture` applies the compiled candidate only to that marked database. It refuses a duplicate foundation. `--indexes-only` resumes after a failed concurrent index build; existing invalid or differently defined indexes stop it for reviewed repair. It validates the deferred inbound-revision constraint after foundation locks are released, confirms REPLICA IDENTITY FULL and verifies the public authorization API remains disabled.

`worker-step.py --owned-fixture --rounds 10` performs bounded durable steps: baseline users/organizations, two historical jobs of 100 rows, two parent-fanout jobs of 100 rows, 20 expiries and 10 summary claims per round. Claims commit before computation; lease/generation fences check publication afterward. Retry handles only whole aborted deadlock/serialization/lock-timeout transactions. It never contacts a provider. This fixture runner is not the production continuously supervised worker service.

## Baseline and reconciliation

Install transactional capture before historical jobs begin. Existing inbound messages keep revision zero; new arrivals receive monotonic heads. Never reset heads, entity generations, sender mappings or user epochs during recovery. Membership epoch seeding scans every distinct historical membership user, including active assignees who never logged in, using conflict-preserving bounded inserts so an existing or concurrent capture revision wins. Historical messages, reviews and threads use the reviewed locked source pages and durable checkpoints; parent fanout and expiry enqueue the same generation-fenced publication path.

Readiness includes baseline progress, historical jobs, pending parent generations, queue state, expiry and unresolved thread identity collisions. These are diagnostic checks, not an automatic permission to enable service. Initial backfill completion must be paired with schema/function fingerprints, source-writer coverage and a measured catch-up threshold. Restores or disabled triggers require a new capture-generation decision and full reconciliation; an empty queue alone cannot prove missed writes never occurred. Duplicate canonical thread identities block rollout until resolved; the installer never silently chooses or deletes one.

## Retention and rollback

The ordinary rollback sets database serving_enabled=false and restores the legacy UI while keeping capture and accepted-job workers operational. It preserves all durable state. Operations and read owners confirmed their accepted work does not retain a runtime/FK dependency on worksets; bounded cleanup may therefore remove expired worksets and their cursors after a configured grace period. Each call deletes at most 1,000 cursor rows and 500 worksets, resuming cursor-heavy scopes across calls. The worker caller must set a statement timeout; the guarded fixture connection uses 30 seconds. The rehearsal default is seven days, bounded from one to 30 days, not a settled production retention policy.

Never reuse that cleanup for operation preparations/items/steps/receipts, shared-contact safety receipts, read boundaries/history cursors or provider delivery state. They have separate execution/replay deadlines and retention contracts. Raw sender mappings and retained revision heads are not reset. Canonical deletion/privacy reconciliation must also be checked before production activation.

If capture itself causes failures, disabling the UI does not remove write-path overhead. An emergency capture detach needs a reviewed dependency-aware packet and a subsequent capture-gap reconciliation; no destructive detach is emitted as routine rollback here. Auth trigger ownership is a concrete constraint: postgres can create its trigger using the observed TRIGGER grant but cannot directly DROP TRIGGER on the Auth-owned table. Dropping its own function CASCADE was verified in the isolated equivalent-role test. Preserve Auth ownership, ACLs and RLS.

## Established migration route

Production promotion uses Sandra's existing `db-migrate-test.yml` followed by `db-migrate-prod.yml`: successful test migration from main, exact tested SHA, ancestry check, committed migration-history safety gate, dry run, then the Production environment approval gate. There is no manual production SQL shortcut or production workflow_dispatch. Do not put generated candidates in the automatically applied migration directory until rehearsal and review are complete. When ready, create migration filenames through the installed Supabase CLI and preserve reviewed source hashes.

The current workflows have a five-minute job timeout. Historical concurrent index duration must be measured before deciding how to split/schedule the final migration packet; do not assume seven large-table builds fit. Invalid concurrent indexes require explicit repair and are never accepted because an index name already exists. Schema validation must confirm the deployed canonical dependencies and Auth permissions match the tested source; successful fixture installation alone is insufficient.

## External dependencies and service boundaries

- Projection/capture/policy/bridge/filter/outcome sources are pinned here; immediate code dependency is PR577 (which depends on575/571).
- Root-owned post-render read/history source is separately reviewed at PR579 /db852ee9 and installed as the pinned companion in this owned fixture. It depends on bridge authorization, access epochs and capture generation/heads. Its boundaries and receipts are retained separately. Do not modify root sources here.
- Operations retain explicit typed selections, definitions and authoritative receipts; no workset FK remains. Final preparation/execution, shared-contact consent ordering and provider sender reconciliation are separate reviewed dependencies. Do not modify those sources here.
- Electric must use only `inbox_bridge.summaries` with a dedicated reviewed replication role/publication and fixed server-side gateway relation. Secrets, slots, replication stream identity and private hosting are not provisioned by this candidate. The frontend configuration supports the stable relation name.
- The production worker image, bounded connection pools, Restate ingress/recovery, health metrics and process supervision are separate deployment dependencies. This package does not claim a shell fixture runner is that service.
- Full canonical owner/name updates, time-based expiry, source-to-worker outcome propagation, realistic concurrent arrivals, held-lock behavior and backlog drain rate must pass on the assembled candidate. The earlier static120k/360k count measurements do not certify these paths.

## Rehearsal results and reproducibility

`install-evidence.json` records a successful intentional late-failure rollback, followed by installation and seven valid concurrent indexes. Foundation wall time was 0.097 seconds on the near-empty owned database; it does not establish acceptable production lock duration. Bootstrap failure logs preserve two missing local platform prerequisites and their ledger-safe resumptions. The successful final bootstrap preserves all 23 real GoTrue Auth tables and vendor ownership.

`smoke-evidence.json` records real canonical inserts and updates propagating through durable claims into summaries and typed facets. The authorization smoke temporarily enabled the database gate inside a transaction that rolled back. Removal after a canonical timestamp was changed to 91 days ago passed. Natural clock expiry without a canonical update subsequently passed in maintenance-evidence.json. Human display-name changes, historical rows predating installation, concurrent arrival throughput and backlog catch-up still require separate tests.

`read-companion.py` compiles three exact PR579 sources plus root-reviewed unknown history at 3b46d7453abc0e0c3196af230f70eef2361cd12d without a database connection. `--owned-fixture` installs only in the guarded database with serving disabled and refuses an existing read schema; `--owned-fixture --verify-only` checks installed bodies and grants without mutation. The original and transformed source hashes are in `read-companion-manifest.json`; the generated SQL and eleven effective function bodies match the current installed receipt. The unknown-history public messages index is separately compiled and executed CONCURRENTLY. Companion compilation never edits the root owner's source files.

The core build receipt includes pinned upstream source hashes, compiler hash, new runtime hash and the final generated foundation hash. Rebuilding does not imply reinstallation; `install-evidence.json.source_sha256` must equal the generated foundation hash before an initial installed claim is made; a subsequent explicitly recorded forward correction is checked separately. Browser fixture enablement is separately authorized and does not change production defaults.

`harden-private.sql` revokes browser/service access to the exact 13 private schemas in `private-schemas.json`, leaving reviewed public SECURITY DEFINER APIs as the entry points. The compiler verifies that this inventory matches the bundled schemas. It does not match arbitrary schema prefixes. `rehearse-hardening.py --owned-fixture` applies the reviewed private-grant and retention-budget correction to the already installed fixture, preserves its serving flag, and verifies disabled API behavior inside a rolled-back assertion. Its forward-correction receipt is separate from the original installation receipt.

`verify.py --installed` compares all 67 effective core function bodies with generated source, verifies no private function has browser/service execution privileges, and checks narrow DTO replica identity. `maintenance-test.py --owned-fixture` is the bounded historical-epoch/retention/natural-expiry regression. The baseline probe deliberately models a missing historical epoch in a rolled-back transaction; it does not pretend to be another fresh database installation.

Read retention is packaged separately in `read-retention.sql` and `unknown-retention.sql`. Both use a fixed seven-day grace and include every deleted child/parent row in their budgets. Known read cleanup locks the boundary before its receipts, skips a boundary held by an active caller, and honors the later of expiry and execution deadline. Standalone unknown cursors have their own indexed expiry cleanup. Actual deadline/grace/held-lock and 1,001-row budget tests passed in the accompanying evidence. Permanent heads, epochs, operation receipts and safety receipts are outside these functions.

The initial maintenance test used an invalid synthetic membership role and then combined a volatile prune call with its count assertion in one SQL expression. Both harness errors were corrected (canonical `member`; separate statements), with the failed logs retained. The final tests passed; neither failed probe committed fixture state.
