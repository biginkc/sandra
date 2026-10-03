#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/failure-exit.sh"
source "$(dirname "$0")/mapfile-compat.sh"
lane_env=''
rehearsal_dir=''
db_contract_cleanup() { if [[ -n "$lane_env" ]]; then rm -f "$lane_env"; fi; if [[ -n "$rehearsal_dir" ]]; then rm -rf "$rehearsal_dir"; fi; }
trap 'heavy_lane_exit "$?" db_contract_cleanup' EXIT
[[ "${HEAVY_LANE:-}" == db-contract-post ]]
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]]
[[ -z "$(git status --porcelain --untracked-files=all)" ]]
if [[ "$(uname)" == Darwin ]]; then [[ "$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')" -ge 8 ]]; fi
inbox_files_output="$(node scripts/inbox-ci/inbox-migrations.mjs --files)"
mapfile -t inbox_migration_files <<<"$inbox_files_output"
inbox_migration_count="$(node scripts/inbox-ci/inbox-migrations.mjs --count)"
[[ "$inbox_migration_count" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid Inbox migration manifest count' >&2; exit 1; }
[[ "${#inbox_migration_files[@]}" -eq "$inbox_migration_count" ]] || { echo "Expected $inbox_migration_count Inbox migration files, received ${#inbox_migration_files[@]}" >&2; exit 1; }
for migration in "${inbox_migration_files[@]}"; do
  version="$(basename "$migration" | cut -d_ -f1)"
  [[ -f "$migration" ]] || { echo "SCHEMA_PHASE_MISMATCH post: migration $version absent" >&2; exit 1; }
done
lane_env="$(mktemp)"
original_env="${GITHUB_ENV:-}"
HEAVY_ORIGINAL_GITHUB_ENV="$original_env"
export GITHUB_ENV="$lane_env"
inbox_exclude_args=()
inbox_exclude_output="$(node scripts/inbox-ci/inbox-migrations.mjs --exclude-args)"
mapfile -t inbox_exclude_args <<<"$inbox_exclude_output"
[[ "${#inbox_exclude_args[@]}" -eq $((2 * inbox_migration_count)) ]] || { echo "Expected $((2 * inbox_migration_count)) Inbox migration exclude arguments, received ${#inbox_exclude_args[@]}" >&2; exit 1; }
node scripts/ci/provision-disposable-stack.mjs --api-port 55421 --db-port 55422 "${inbox_exclude_args[@]}"
set -a
source "$lane_env"
set +a
if [[ -n "$original_env" ]]; then cat "$lane_env" >> "$original_env"; fi
export GITHUB_ENV="$original_env"
export MESSAGING_PROVIDER=mock
rehearsal_dir="$(mktemp -d)"
export HEAVY_PRE_READONLY_OUTPUT="$rehearsal_dir/pre-readonly.json"
node scripts/inbox-ci/rehearse-readonly.mjs --phase pre --prepare-fixture 1 --output "$HEAVY_PRE_READONLY_OUTPUT" > "$rehearsal_dir/pre-result.json"
export HEAVY_REHEARSAL_ORG="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).org' "$rehearsal_dir/pre-result.json")"
for migration in "${inbox_migration_files[@]}"; do
  version="$(basename "$migration" | cut -d_ -f1)"
  name="$(basename "$migration" .sql | cut -d_ -f2-)"
  psql "$E2E_CI_SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f "$migration" > "$rehearsal_dir/apply-$version.txt"
  psql "$E2E_CI_SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v version="$version" -v name="$name" > /dev/null <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (:'version',:'name',ARRAY['db-contract-post local rehearsal']);
SQL
done
bash scripts/inbox-ci/build-operator-indexes.sh
mutations="${RUNNER_TEMP:-/tmp}/db-contract-post-mutations-${HEAVY_TESTED_SHA}.json"
node scripts/outbox-db-contract-mutations.mjs "$mutations" --phase post
