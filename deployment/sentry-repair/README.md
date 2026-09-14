# Sandra Sentry repair runner

This is a Railway service definition for the long-lived controller process. It
is a deployment artifact only; it does not create a Railway project, service,
volume, variable, or secret.

Configure the service with a mounted Railway volume at `/data` and set
`SANDRA_REPAIR_DB_PATH=/data/repair.db`. The process refuses a missing,
relative, in-memory, or non-writable database path so a restart cannot silently
discard scheduler and outbox state. Set `SENTRY_AUTH_TOKEN` as a controller
secret. Leave `SANDRA_GITHUB_PUBLISH_ENABLED=false` until the GitHub App
installation and the dry-run evidence are approved. When that gate is
explicitly enabled, provide `GITHUB_TOKEN` as a controller-only secret and
restrict `SANDRA_GITHUB_REPOSITORY` to the Sandra repository.

Railway supplies `PORT`; the runner exposes `/healthz` and `/readyz` on that
port. The process polls current America/Chicago slots, claims each UTC slot
once in SQLite, and never replays missed slots after a restart. It retries a
failed intake within the same slot with a bounded exponential delay and caps
GitHub publications per cycle.

`SANDRA_REPAIR_DISPATCH_ENABLED` must remain unset or `false`. A future
staged-repair rollout must pass a separately reviewed gate; this service
currently performs intake and optional engineering-queue publication only.

No credentials are accepted in command-line arguments, emitted in health
responses or logs, copied to worker environments, or baked into the image.
