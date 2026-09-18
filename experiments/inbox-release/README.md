# Inbox release gate

This directory contains the release-only package and readiness gate for the
Sandra Inbox. It is deliberately separate from the shared browser acceptance
specs and from `supabase/migrations`.

The gate is fail-closed. A green package compile or unit suite does not make a
release candidate ready. The gate requires exact source hashes, a live
installed-catalog proof, every required acceptance row with an artifact, real
measurements at the current and three-times volume tiers, and worker/relay
recovery evidence. Missing, stale, skipped, blocked, invented, or
placeholder evidence is reported as `BLOCKED` or `FAIL`, never as a pass.

The release database is a new database named by `release-manifest.json` in the
guarded local Postgres container. The existing backend-owned
`sandra_inbox_install_20260913` database is never reset or used by this gate.
Creating the release database requires an explicit backend ownership window;
the gate will not create it implicitly.

Safe local checks (compiler, source-manifest validation, and service unit
tests) can be measured without a database:

```sh
python3 experiments/inbox-release/release_gate.py \
  --manifest experiments/inbox-release/release-manifest.json \
  --run-safe --write work/inbox-release-safe.json
```

The command exits non-zero while any required gate is blocked. It records the
actual command return code, wall time, candidate SHA, generated package hashes,
and blocker details in the output file. It never deploys, creates Railway
resources, enables serving, or contacts a provider.

After the backend has confirmed the DB window and the release fixture has been
created and marked, run the installer and evidence-producing checks explicitly:

```sh
python3 experiments/inbox-release/release_gate.py \
  --manifest experiments/inbox-release/release-manifest.json \
  --run-safe --run-installed \
  --evidence-dir work/inbox-release-evidence \
  --write work/inbox-release-readiness.json
```

`--run-installed` only accepts the release database identity and marker. It
refuses the original database, a remote DSN, a missing marker, a reset attempt,
or a serving-enabled fixture. It calls the existing installation scripts and
keeps their evidence intact. The production SQL migration route and hosting
provisioning remain separate reviewed steps.

Evidence files supplied through `--evidence-dir` must be JSON and must contain
`status: "PASS"`, a candidate SHA, a release fixture identity, non-zero sample
counts where measurements are claimed, and finite measured values. The gate
also checks the approved p95 targets and the 50-recipient cap. A file with
`placeholder`, `synthetic-pass`, `not-run`, `unknown`, or `TODO` markers cannot
certify a gate.

The generated readiness document is an evidence index, not permission to
enable the product. Keep the server, database, and provider flags disabled
until the coordinating release review accepts the complete packet.

The disposable HTTP fixture is separate from the release installer database.
It is owned by the release lane, carries the marker
`sandra-inbox-release-http-owned-20260917`, and is bound only to
`http://127.0.0.1:54321` with database DSN
`postgresql://postgres:postgres@127.0.0.1:54322/postgres`. The shared
Supabase stack on ports 58421/58422 and the backend-owned T2 database remain
excluded. `http-stack-probe.py` checks those ownership markers, exact port
bindings, database identity, Auth, PostgREST, Realtime, bounded resources,
and an authenticated RPC.

Realtime is a required HTTP fixture prerequisite for legacy Inbox/Outbox
subscription checks. The cached image is pinned to
`public.ecr.aws/supabase/realtime:v2.129.3@sha256:3211f8ebd59edcd0aa772186f1c8249c82c6b1ae5565f40dedb7aa93e951fe37`.
It must run as the marked `sandra-inbox-release-http-realtime-20260917`
container on the owned network with the `realtime` alias, a 384 MiB/0.5 CPU
bound, and an internal-only `/realtime/v1/` gateway route. The probe remains
blocked until that service is present; no external image pull is authorized.
The probe also performs a WebSocket upgrade at `/realtime/v1/websocket` and
requires HTTP 101; the marked gateway must route that request to Realtime's
`/socket/websocket` endpoint. A 200 health response alone is insufficient.

`realtime-cdc-proof.mjs` is the narrow authenticated CDC proof for that
fixture. It requires the independent probe's exact API/database and identity
markers, signs in the ordinary acceptance user with the anon key, subscribes
to `public.messages` filtered to the explicitly supplied organization, and
waits for `SUBSCRIBED` before inserting one generated UUID through the service
client. It passes only when the subscribed client receives a WebSocket
`postgres_changes` `INSERT` for that same UUID and organization. The proof
does not REST-poll for the event, call a provider, or exercise outbound
delivery. Its `finally` path deletes only that UUID within that organization,
including after an uncertain insert response.

The operator supplies the private runtime environment and the already
pre-seeded scenario identities; the script never prints keys or passwords:

```sh
node experiments/inbox-release/realtime-cdc-proof.mjs
```

Required scenario variables are `INBOX_HTTP_CDC_ORG_ID`,
`INBOX_HTTP_CDC_CONVERSATION_ID`, `INBOX_HTTP_CDC_CONTACT_ID`,
`INBOX_HTTP_CDC_PROPERTY_ID`, `INBOX_HTTP_CDC_FROM_ADDRESS`, and
`INBOX_HTTP_CDC_TO_ADDRESS`. The runtime environment must also provide the
exact target markers, `INBOX_HTTP_ANON_KEY`, service key, existing acceptance
user credentials, `INBOX_NO_PROVIDER=1`, and the exact loopback API/database
values described above. `test_realtime_cdc_proof.mjs` exercises the guard and
scenario validation without connecting to the fixture.

The pinned image's tenant migrations require an administrative migration
connection even when the long-running CDC process uses a constrained role.
`realtime-bootstrap.py` is the reproducible repair path for the local fixture:
its default mode is read-only, and `--apply` first validates the database
marker, network/container labels, running image ID, and cached digest. It then
grants only `REPLICATION` and `SET log_min_messages` to
`supabase_realtime_admin`, runs the pinned image's pending migrations in a
temporary marked container as `supabase_admin`, and restores the long-running
container with the constrained role. The private migration env file is never
read or printed by the script. The apply path requires both
`INBOX_RELEASE_ALLOW_RUNTIME_MUTATION=1` and an explicit owner-readable
`--migration-env-file`; it refuses shared or unmarked targets, image pulls,
and incomplete migration catalogs. The temporary process does not self-seed;
it must advance the existing `realtime-dev` tenant's migration ledger. Before
stopping the service and after restoring it, the script asks the pinned image
to decrypt the tenant settings and requires the effective `db_user` to remain
`supabase_realtime_admin`; it also fingerprints the encrypted settings to
reject any rewrite. It checks migration `20260709120000` and the
`action_filter`/`selected_columns` subscription columns before reporting
completion. A separate WebSocket/subscription probe remains required for
functional event delivery.

The packet also records the coordinator policy: exact-head Opus 5 approval is
required, approval is invalidated by any new commit, and the coordinator gate
must be satisfied before release status can advance.

The projection role packet is assembled with the exact coordinator source and
can only be applied through the guarded release-database command:

```sh
python3 experiments/inbox-release/assemble-worker-role-packet.py \
  --source-repo "/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/release-integration" \
  --commit 28765326a7dd1ce9080c4c6beca1bf564417908d
```

The command above only emits the packet and receipt. Applying it requires the
explicit release database and marker environment variables plus
`--apply`; it runs the packet's database identity guard and never accepts the
backend-owned install database.

The candidate separates session/membership authority from serving admission.
`inbox_bridge.authorize()` remains available to authenticated receipt and
recovery paths while read-serving callers use `authorize_serving()`. New
action/reply/saved command adapters must call
`inbox_control.admit_command(<allowlisted-family>)`; the helper derives the
actor and organization from `auth.uid()` and the verified membership, then
requires an enabled family plus an organization/user cohort row (or explicit
`all` mode). The rollback packet disables every family in the same transaction
as `serving_enabled=false`, preserving receipt reads.

The package intentionally does not import unreviewed operation or provider
SQL. If those adapters are absent, the installed rollback probe reports a
blocker. If present, it invokes the public prepare RPC after rollback inside a
rolled-back transaction and requires `INBOX_COMMAND_DISABLED`; a helper-only
unit assertion cannot satisfy that gate.

The required execution services are pinned in
`execution-stack-manifest.json`. It records the current operation and reply
worker source hashes and the cached Node base image, while leaving their build
status blocked until the current source is built and matching command adapters
and worker grants are installed. Historical cached worker images do not
certify compatibility with this candidate.

The same execution manifest now pins the projection worker source, its
`worker-role.sql`, bounded local-fixture profile, and the database-role install
order. The projection role packet must be applied before its runtime starts;
the packet creates a constrained `NOLOGIN` role and does not provision a
credential. Operation and reply role packets remain in the generated backend
packet and must likewise precede their runtimes. A hosting review must create
the separate constrained login and prove its grants before any worker image is
accepted.

The exact backend operation/reply source packet is recorded separately in
`backend-operation-reply-manifest.json`. It is pinned to the coordinator-supplied
backend snapshot and remains `PENDING_REVIEW_NO_INSTALL` until the runtime combo
proof, wrapper admission transforms, and receipt rollback proofs are complete.
`assemble-backend-packet.py` re-reads that exact commit with `git show`, records
every SQL/runtime hash, emits the transformed SQL packet, and has no database or
container side effects. The packet includes saved-action version storage and the
prepare-time immutable reference binding, then gates saved create/update/delete
and list/get wrappers with the separate saved read/write command families.

The reproducible disposable HTTP fixture templates are checked in beside the
manifest: `http-stack-compose.yml`, `http-stack-kong.yml`, and the two
secret-free environment examples. The Compose template uses `pull_policy:
never`, exact ownership labels, bounded services, and the `/socket` Realtime
upstream mapping; a missing cached image fails closed instead of pulling.

The action and reply workers have a source-only local profile for this fixture.
It accepts only `127.0.0.1:54322/postgres` in test mode, requires the database
identity marker `sandra-inbox-http-owned-synthetic-20260917`, the container
label marker `sandra-inbox-release-http-owned-20260917`, the
`sandra-inbox-release-http` purpose, and verified labels, then authenticates as
the constrained `inbox_action_worker` or `inbox_reply_send_worker` login. The
historical aliases and production certificate path remain separate. The
profile is recorded as an unbuilt overlay in `execution-stack-manifest.json`;
no worker launch is implied.

## Complete execution stack definition

`execution-stack-compose.yml` is the checked-in synthetic full-stack definition
for the separately owned HTTP fixture. Its opt-in `full-runtime` profile wires
the pinned Restate runtime, Electric, current-source operation worker,
reply-send worker, projection worker and the release-only relay wrapper. It
uses host mode only for Restate and the workers because the reviewed local
profiles deliberately accept only the exact `127.0.0.1:54322/postgres` target
and the `sandra-inbox-restate-owned:8080` ingress alias. Electric and the
fixture relay join the existing marked release HTTP network. `full-stack.env.example`
contains names only; credentials and the Restate key stay in ignored files.

The compose definition is deployable configuration, not runtime evidence. The
operation, reply and projection images are built from the exact `4850f8c` source
snapshot and have no accepted digest until that build runs. Electric is pinned
to the previously reviewed 1.8.1 digest, but its publication, replication role
and compatibility with the current candidate still require the separate
database packet. `experiments/inbox-production-install/electric-replication-role.sql`
is that packet: it is guarded by the release database and marker, creates only
`inbox_electric_replication`, grants `CONNECT`, schema `USAGE`, and summary-table
`SELECT`, enforces `REPLICA IDENTITY FULL`, and creates the one-table
`electric_publication_inbox_release_20260917`. The password is supplied at
execution time with `psql -v`; it is never stored in this tree. The compose
environment names this constrained replication role and never falls back to the
`postgres` administrator. The fixture relay imports the reviewed relay factory through
`relay-fixture.mjs`; the production entry point remains
`services/inbox-sync-relay/server.mjs`, which accepts only a private Railway
Electric hostname.

Restate deployment registration is a separate guarded operation. After the
owned Restate and worker containers pass their exact label, image, host-network,
and fixture-profile checks, run
`register-restate-services.py` without mutation to inspect the admin health.
Only after worker readiness and database checks pass may the operator set
`INBOX_RELEASE_ALLOW_RUNTIME_MUTATION=1` and add
`--register-owned-runtime`; the helper then posts only
`http://127.0.0.1:9080` (`InboxMetadataOperation`) and
`http://127.0.0.1:9081` (`InboxReplySend`) to the owned Restate admin at
`http://127.0.0.1:9070`. It does not start, stop, pull, or remove containers,
and writes a redacted registration receipt. No registration or replication
receipt exists in this candidate yet.

The current read-only daemon probe returned containerd blob I/O errors while
inspecting the historical and infrastructure images. No cache availability or
runtime readiness is claimed from those references. The remaining concrete
runtime evidence is recorded under `runtime_definition.missing_evidence` in
`execution-stack-manifest.json`: exact current image digests, role/publication
installation, Restate registration and recovery, and measured current/three
times workload observations.

`stress-harness-config.json` and `run-stress-recovery.py` provide the actual
current/three-times workload and fault-recovery execution contract. A workload
adapter and a fault adapter must emit JSONL timing, CPU/memory/lock/connection,
and recovery observations against the independently probed owned target. The
checked-in profiles intentionally have no arrival, concurrency, tenant, or
history values, so `--validate-config` reports `BLOCKED_UNJUDGED`. Missing
measurements and missing thresholds cannot certify a pass; the runner only
reports timing budgets from the approved release manifest and keeps ingestion,
queue, system, and recovery thresholds unjudged until the coordinator supplies
and measures them.

The browser workload adapter does not call navigation to a pre-seeded row
ingestion. That row existed before the workload and therefore measures only
read/load time. Ingestion remains missing until an owned provider-double or
source-fixture adapter supplies a source message id and arrival timestamp and
the read probe observes that exact message at a positive projected version.
`sourceArrivalTiming` is the checked-in contract for that record and rejects
observations without an arrival timestamp or with no delay. The checked-in
`browser-workload/source-arrival-adapter.mjs` is the owned source-fixture
path: it requires an exact pre-seeded org/conversation/contact/property/sender
scenario, inserts only new inbound synthetic messages through the local
Supabase service client, and polls the exact `last_message_id`, source
generation, bridge revision, and filter revision over a read-only PostgreSQL
connection. Each inserted message is read back in one post-commit query that
captures its server-owned `public.messages.inbox_inbound_revision` as identity
evidence and the target's `inbox_message_capture.dirty.generation` as the
projection cutoff. The timing sample requires both values, but readiness uses
only the dirty-generation counter because inbound revision is a separate
per-conversation counter. A coalesced worker may have advanced
`last_message_id` to a later message, which is valid after that generation
catch-up and is recorded in the manifest rather than treated as
intermediate-message loss. The adapter requires an explicit message count and
operator-supplied bound (`INBOX_RELEASE_SOURCE_MESSAGE_COUNT` and
`INBOX_RELEASE_SOURCE_MAX_MESSAGES`, with count no greater than the bound),
schedules those inserts open-loop, and writes an ID manifest for cleanup
ownership. The checked-in harness does not fill either value from historical
volume data; absent workload dimensions remain blocked.
It requires
`INBOX_RELEASE_SOURCE_FIXTURE_ENABLED=1` and the runner's explicit
`--source-arrival-command`; without those inputs ingestion remains blocked.
The adapter accepts the private service key from `INBOX_RELEASE_SERVICE_ROLE_KEY`
or the existing ignored fixture variable `HTTP_SERVICE_ROLE_KEY`, and accepts
the exact database DSN from `INBOX_RELEASE_DATABASE_URL` or the projection
fixture variable `INBOX_PROJECTION_DATABASE_URL`.
Source IDs are planned and atomically written to the manifest before the first
insert request. The bounded source schedule is open-loop: projection
completion cannot delay later arrivals. Set
`INBOX_RELEASE_SOURCE_BURST_SIZE`, `INBOX_RELEASE_SOURCE_BURST_GAP_MS`, and
`INBOX_RELEASE_SOURCE_START_DELAY_MS` only for a measured fixture profile; a
request error or timeout records that planned id as `uncertain` and aborts
without retrying it. Each successful id is observed independently by exact
message id and projection generation, and a skipped/unobservable id blocks
the run rather than being attributed to a later projected row. The runner
also passes the checked-in database purpose into the adapter's identity guard;
the live fixture identity table's marker is the authoritative database row.
The adapter names
its cycle-start rate `operator_arrival_rate_rps`; it is the workload/operator
arrival rate, not a new-message ingestion rate. Queue timings remain explicitly
accept-to-terminal-receipt timings for metadata and reply operations. These
records are emitted only after the corresponding observations; they are not
inferred from configured rates. The runner starts the workload and
source, workload, and fault/resource adapters together, and
the fault adapter waits for the workload-ready marker before taking a bounded
resource sample window. CPU, memory, lock, and connection records come from
the marked containers and database. No threshold is invented for those records.

`fault-recovery-adapter.py` is the checked-in fault/resource adapter. It
requires `INBOX_RELEASE_FAULTS` to name real marked-container restarts, checks
the Docker labels and database marker before every mutation, and emits only
observed recovery and resource records. It returns `BLOCKED` when the owned
fixture is stopped or any marker/health check is unavailable.

When `INBOX_RELEASE_FULL_RUNTIME=1`, the same ownership guard includes the
marked Restate, Electric, operation-worker, reply-worker, and relay containers.
Recovery checks use Restate `/health`, operation/reply `/readyz`, relay `/health`,
and the relay health path as the Electric upstream check. Supported fault names
are the manifest container keys with an optional `_restart` suffix. The
full-runtime process is still source-only until its images, role/publication,
and registration receipts exist.
