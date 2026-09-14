# Sandra Sentry repair runner

This is a Railway service definition for the long-lived controller process. It
is a deployment artifact only; it does not create a Railway project, service,
volume, variable, or secret by itself.

## Explicit Railway deployment

The repository uses Railway Infrastructure as Code at
`.railway/railway.ts`. Railway's current IaC workflow requires CLI 5.42.1 or
newer and the `railway` TypeScript SDK. From a directory linked to the target
Railway project, run the following read-only plan first:

    railway config plan

Review that the plan and deployment details read back exactly one
`sandra-sentry-repair` service, one `/data` volume mount, the Dockerfile at
`deployment/sentry-repair/Dockerfile`, the start command
`/usr/local/bin/sandra-sentry-repair-entrypoint`, and the `/readyz` health
probe with a 300-second startup window. Apply only after that review:

    railway config apply

Then verify the running service and the deployed configuration from Railway:

    railway service status --json
    railway deployment list --service sandra-sentry-repair --json
    railway logs --service sandra-sentry-repair --latest --json
    railway volume list --json

The IaC file preserves existing secret values without placing them in source.
Populate missing `SENTRY_AUTH_TOKEN` and, only after the GitHub publication
gate is approved, the GitHub App values through the Railway variable UI or
`railway variable set --stdin`; never pass secrets in command arguments or
commit them. The current live CLI in this checkout may predate IaC support;
upgrade it before planning and confirm `railway --version` is at least 5.42.1.

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
port. Railway probes `/readyz`, which remains 503 until the process has
completed a successful first intake and any persisted failed or
`create_unknown` GitHub publication backlog is clear. This avoids declaring a
deployment ready while its durable queue is unhealthy. The 300-second
healthcheck timeout allows the first bounded Sentry request to complete before
Railway marks startup failed. The process polls current America/Chicago slots, claims each UTC slot
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
