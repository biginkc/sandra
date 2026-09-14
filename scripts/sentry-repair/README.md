# Sandra Sentry repair controller

This is a small, stdlib-only controller for deterministic Sentry intake and
bounded repair state. It is intentionally an operator-facing building block.
The `runner.py` entry point supplies the long-lived intake and optional GitHub
outbox process used by the Railway deployment artifact; this repository change
does not create Railway infrastructure, provision a volume, or install a
service automatically. The controller does not send Slack messages, merge PRs,
or deploy releases.

The canonical source is Sentry organization bmh-group, project sandra,
environment vercel-production. Live intake reads SENTRY_AUTH_TOKEN; use an
offline fixture for tests and rehearsals:

    python3 scripts/sentry-repair/cli.py --db /var/tmp/sandra-repair.db init
    python3 scripts/sentry-repair/cli.py --db /var/tmp/sandra-repair.db intake \
      --issues-file fixture.json

Set `SANDRA_REPAIR_WORKTREE_ROOT` (or pass `--worktree-root`) to the owned
worktree parent before making an investigate/repair claim. The claim rejects
the main checkout and any path outside that root. Controller fencing tokens
are supplied through `SANDRA_FENCING_TOKEN` or `--fencing-token-file`; they
are never placed in Codex worker argv.

The database defaults to XDG_STATE_HOME/sandra-sentry-repair/repair.db, or
~/.local/state/sandra-sentry-repair/repair.db. Keep it on durable storage
outside a checkout. Sentry issues are keyed by their positive numeric id;
short IDs such as SANDRA-A are evidence only and are never the idempotency
key.

## Long-lived Railway runner

`runner.py` requires `SANDRA_REPAIR_VOLUME_PATH` to name a writable mounted
directory and `SANDRA_REPAIR_DB_PATH` to name an absolute file below that
directory. Set them to `/data` and `/data/repair.db` on Railway; the process
checks the mount boundary and refuses image storage, in-memory state, or a
path outside the volume. `SENTRY_AUTH_TOKEN` is required for live intake.
GitHub publication remains disabled unless
`SANDRA_GITHUB_PUBLISH_ENABLED=true` and controller-only GitHub App settings
(`SANDRA_GITHUB_APP_ID`, `SANDRA_GITHUB_INSTALLATION_ID`, and an unencrypted
`SANDRA_GITHUB_APP_PRIVATE_KEY`) are provided through the service environment.
The provider mints short-lived installation tokens in memory and renews them
before expiry. The runner never places credentials in argv, logs, health
responses, or worker environments.

The process claims the current America/Chicago slot once in SQLite, performs a
fresh Sentry snapshot, and optionally drains a bounded number of GitHub outbox
jobs. A failed intake is retried a bounded number of times with capped
exponential delay. `/healthz` and `/readyz` expose sanitized process state.
`deployment/sentry-repair/` contains the Dockerfile and startup script;
`.railway/railway.ts` is the explicit Railway service configuration and
`deployment/sentry-repair/README.md` contains the volume/secret setup notes.
`SANDRA_REPAIR_DISPATCH_ENABLED` must remain false;
the repair-dispatch gate is reserved for a separately reviewed rollout.

Use observe (the default) for intake and reporting. investigate permits a
bounded investigation dispatch, while repair permits a bounded patch
dispatch. There is one global active attempt. The SQLite transaction claims a
random fencing token. An expired lease changes to reconcile_required; a
second worker cannot restart it until an operator records explicit
reconciliation evidence. A stale worker's token cannot mutate state after
reconciliation.

An investigate worker is read-only and never marks an issue resolved. After
its evidence is collected, the operator must run
`finish-investigation --attempt-id ID --evidence TEXT` with the fencing token.
That explicit transition closes the attempt and releases the global lease;
letting the lease expire instead requires normal stale-lease reconciliation.
Use the fenced `fail --attempt-id ID --reason TEXT` transition when a repair is
rejected or otherwise cannot safely complete.

Investigate and repair claims require an existing absolute Git worktree (and
optionally an exact branch). The controller verifies it is a linked worktree,
not the main checkout, before claiming and launches Codex with that worktree as
cwd. The fencing token is hashed in SQLite and is controller-only
authorization; it is never put in worker/reviewer prompts or completion
payloads.

Attempt history is bounded to two attempts per issue generation. A resolved
issue does not create another generation merely because its lastSeen changed.
The intake payload must explicitly carry a verified, evidenced post-resolution
regression with a new regression identity. Repeating that identity is
idempotent.

dispatch is a dry-run unless --execute is supplied. Dry-run only builds a
local argv plan and does not call Codex. An executing dispatch probes Spark
before any repair work, extends the lease through the timeout, and heartbeats
the lease while the subprocess runs. Spark uses gpt-5.3-codex-spark at low or medium effort. Luna
(gpt-5.6-luna, xhigh) is selected only when the probe explicitly proves model
unavailability or quota exhaustion. Timeout, auth, malformed CLI, and unknown
errors stop the invocation and are not retried automatically. Review uses a
separate Astra session (gpt-6-astra, medium); Fable, when used, is a separate
Claude CLI and is never sent to Codex.

The review command is also dry-run by default. With --execute, it requires an
existing repair session plus persisted PR/CI, deployment, functional-probe,
and Sentry evidence. It invokes an explicit Astra medium Codex command in
read-only mode from a fresh clean detached checkout at the persisted PR SHA,
ignores repository execpolicy rules and sets `-c project_doc_max_bytes=0`,
parses a strict raw JSON decision only
from a final `agent_message`, obtains the session ID from a real thread event,
and only then persists an immutable evidence snapshot for the independent
review gate. Review execution and format failures leave the repair attempt
running for retry; they do not burn an attempt. Manual record-review writes
are disabled. Use `heartbeat` with
the fencing token file/env to extend the lease while CI, deployment, and
post-deployment observation finish.

Codex workers receive a strict environment allowlist containing only process
basics and model-auth variables; Sentry, repository, provider, and fencing
secrets are removed. A repair attempt admits one worker dispatch and one
execution session; later dispatches are rejected.

Completion requires an exact evidence record tying together the PR head SHA,
successful CI run and SHA, a production deployment target whose commit is the
PR head or a verified descendant, passing functional probe and Sentry
no-regression observations recorded after deployment, and independent Astra
approval. Status labels alone are rejected. The outbox is persisted and deduplicated for a future notifier;
this package intentionally has no Slack sender.

GitHub engineering-queue publication is controller-only and dry-run by
default. Preview one candidate without changing state:

    python3 scripts/sentry-repair/cli.py --db /var/lib/sandra/repair.db \
      github-publish --issue 123

An explicit publisher invocation requires a controller-only token in the
environment variable named by `--token-env` (default `GITHUB_TOKEN`) and
never accepts a token as a command-line argument:

    GITHUB_TOKEN=... python3 scripts/sentry-repair/cli.py \
      --db /var/lib/sandra/repair.db github-publish --issue 123 --execute

The publisher writes a generation-keyed GitHub outbox row and source link in
one transaction, searches for the exact body marker before creating an issue,
and validates the marker, labels, numeric issue number, and HTTPS URL on every
readback. A lost or malformed create response changes the job to
`create_unknown`; only a later marker reconciliation can close it, so a
transport retry never blindly creates a duplicate. GitHub API error bodies are
discarded and credentials are held only by the controller process.

The schedule helper evaluates America/Chicago local day/night boundaries:
15-minute slots from 06:00 inclusive through 21:00 exclusive, and 30-minute
slots overnight. Slot IDs are UTC instants, so repeated DST-fallback wall times
remain distinct. schedule claims only the current slot at most once after
restart; missed historical slots are not replayed.

Each poll starts from Sentry's current snapshot. The terminal page cursor is
stored as retrieval evidence only and is never used as the next poll's starting
position; this avoids missing issues that became unresolved after the previous
snapshot while the issue primary key reconciles overlap.

Scheduler availability remains conditional: no scheduler is installed here.
On a local Mac, a launchd/Codex heartbeat would depend on the computer being
awake and the Codex app/CLI being available; overnight coverage requires an
always-on host and a separate operational decision.
