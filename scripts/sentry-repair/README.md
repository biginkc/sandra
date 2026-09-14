# Sandra Sentry repair controller

This is a small, stdlib-only controller for deterministic Sentry intake and
bounded repair state. It is intentionally an operator-facing building block.
It does not install a scheduler, start workers, send Slack messages, merge PRs,
or deploy releases.

The canonical source is Sentry organization bmh-group, project sandra,
environment vercel-production. Live intake reads SENTRY_AUTH_TOKEN; use an
offline fixture for tests and rehearsals:

    python3 scripts/sentry-repair/cli.py --db /var/tmp/sandra-repair.db init
    python3 scripts/sentry-repair/cli.py --db /var/tmp/sandra-repair.db intake \
      --issues-file fixture.json

The database defaults to XDG_STATE_HOME/sandra-sentry-repair/repair.db, or
~/.local/state/sandra-sentry-repair/repair.db. Keep it on durable storage
outside a checkout. Sentry issues are keyed by their positive numeric id;
short IDs such as SANDRA-A are evidence only and are never the idempotency
key.

Use observe (the default) for intake and reporting. investigate permits a
bounded investigation dispatch, while repair permits a bounded patch
dispatch. There is one global active attempt. The SQLite transaction claims a
random fencing token. An expired lease changes to reconcile_required; a
second worker cannot restart it until an operator records explicit
reconciliation evidence. A stale worker's token cannot mutate state after
reconciliation.

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
existing repair session, invokes an explicit Astra medium Codex command in
read-only mode, parses an actual JSON/JSONL decision and session ID, and only
then persists the independent review gate. Manual record-review writes are
disabled.

Completion requires an exact evidence record tying together the PR head SHA,
successful CI run and SHA, deployed SHA, passing functional probe, Sentry
no-regression observation, and independent Astra approval. Status labels alone
are rejected. The outbox is persisted and deduplicated for a future notifier;
this package intentionally has no Slack sender.

The schedule helper evaluates America/Chicago local day/night boundaries:
15-minute slots from 06:00 inclusive through 21:00 exclusive, and 30-minute
slots overnight. Slot IDs are UTC instants, so repeated DST-fallback wall times
remain distinct. schedule claims the current/catch-up slot at most once.

Each poll starts from Sentry's current snapshot. The terminal page cursor is
stored as retrieval evidence only and is never used as the next poll's starting
position; this avoids missing issues that became unresolved after the previous
snapshot while the issue primary key reconciles overlap.

Scheduler availability remains conditional: no scheduler is installed here.
On a local Mac, a launchd/Codex heartbeat would depend on the computer being
awake and the Codex app/CLI being available; overnight coverage requires an
always-on host and a separate operational decision.
