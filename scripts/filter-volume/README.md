# Filter translator volume gate (PR A, stress plan #9)

Local, opt-in, never against a shared project. The suite refuses to run unless
both the API URL and DB URL are loopback (`assertLocalOnlyEnvironment`).

1. Disposable stack (separate ports/project id from your dev stack):
   a workdir with `supabase/config.toml` (`project_id = "sandra-filter-vol"`,
   `[api] port = 55331 max_rows = 1000`, `[db] port = 55329`, storage and realtime
   enabled), `supabase/migrations` symlinked to this repo, then
   `supabase start -x studio,imgproxy,inbucket,logflare,vector,edge-runtime,mailpit,postgres-meta,supavisor`.
2. `FILTER_VOLUME=1 npx vitest run --config vitest.filter-volume.config.ts`
   (set `FILTER_VOLUME_RESEED=1` to reseed; `FILTER_VOLUME_SAMPLES=12` per case).
3. Results land in `scripts/filter-volume/results/` (gitignored): `latest.json`,
   `nested-plans.txt` (auto_explain nested + pg_stat_statements track=all), `env.json`.

Budget: per case, new p95 <= 2x the frozen legacy translator's p95 in the same
run. If any case is over budget the gate fails; do not switch to the
denormalised-column fallback without an Opus 5.5 review.


## Isolation (no defaults)
Every script requires an explicit private stack: `SBX_PROJECT` (supabase project_id), `SBX_DB_PORT`, `SBX_WORKDIR`, plus `FILTER_LOCAL_DB_URL` / `FILTER_LOCAL_API_URL` for vitest, and `SUPABASE_CLI` (pinned 2.109.1). Nothing falls back to a shared stack; the identity guard checks the container, port, postmaster start time and absence of other-agent databases before each restart/revert/push.
