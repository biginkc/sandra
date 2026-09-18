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

The packet also records the coordinator policy: exact-head Opus 5 approval is
required, approval is invalidated by any new commit, and the coordinator gate
must be satisfied before release status can advance.

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
