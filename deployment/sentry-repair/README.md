# Sandra Sentry repair runner

This is a Railway service definition for the long-lived controller process. It
is a deployment artifact only; it does not create a Railway project, service,
volume, variable, or secret.

Configure the service with a mounted Railway volume at `/data`, set
`SANDRA_REPAIR_VOLUME_PATH=/data`, and set
`SANDRA_REPAIR_DB_PATH=/data/repair.db`. The process verifies that `/data` is
an effective writable mount and that the database is inside it, refusing image
storage, missing parents, relative paths, and in-memory state. This prevents a
restart from silently discarding scheduler and outbox state. Set
`SENTRY_AUTH_TOKEN` as a controller secret. Leave
`SANDRA_GITHUB_PUBLISH_ENABLED=false` until the GitHub App installation and
dry-run evidence are approved. When that gate is explicitly enabled, provide
the App ID, installation ID, and unencrypted RSA private key as
controller-only secrets (`SANDRA_GITHUB_APP_ID`,
`SANDRA_GITHUB_INSTALLATION_ID`, and `SANDRA_GITHUB_APP_PRIVATE_KEY`). The
runner mints renewable installation tokens in memory; it does not accept a
static `GITHUB_TOKEN`.

Railway supplies `PORT`; the runner exposes `/healthz` and `/readyz` on that
port. The process polls current America/Chicago slots, claims each UTC slot
once in SQLite, and never replays missed slots after a restart. It retries a
failed intake within the same slot with a bounded exponential delay and caps
GitHub publications per cycle.

The image starts with a small root bootstrap only long enough to make the
`/data` mount writable for UID 10001; it then uses `setpriv` to run the Python
controller as the unprivileged `sandra` user. The Railway start command is
intentionally omitted so the image entrypoint cannot receive a duplicate
`python3` command.

`SANDRA_REPAIR_DISPATCH_ENABLED` must remain unset or `false`. A future
staged-repair rollout must pass a separately reviewed gate; this service
currently performs intake and optional engineering-queue publication only.

No credentials are accepted in command-line arguments, emitted in health
responses or logs, copied to worker environments, or baked into the image.
