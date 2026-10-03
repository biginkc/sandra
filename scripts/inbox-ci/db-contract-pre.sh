#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/failure-exit.sh"
source "$(dirname "$0")/mapfile-compat.sh"
lane_env=''
db_contract_cleanup() { if [[ -n "$lane_env" ]]; then rm -f "$lane_env"; fi; }
trap 'heavy_lane_exit "$?" db_contract_cleanup' EXIT
[[ "${HEAVY_LANE:-}" == db-contract-pre ]]
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]]
[[ -z "$(git status --porcelain --untracked-files=all)" ]]
if [[ "$(uname)" == Darwin ]]; then [[ "$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')" -ge 8 ]]; fi
lane_env="$(mktemp)"
original_env="${GITHUB_ENV:-}"
HEAVY_ORIGINAL_GITHUB_ENV="$original_env"
export GITHUB_ENV="$lane_env"
inbox_exclude_args=()
inbox_exclude_output="$(node scripts/inbox-ci/inbox-migrations.mjs --exclude-args)"
mapfile -t inbox_exclude_args <<<"$inbox_exclude_output"
inbox_migration_count="$(node scripts/inbox-ci/inbox-migrations.mjs --count)"
[[ "$inbox_migration_count" =~ ^[1-9][0-9]*$ ]] || { echo 'Invalid Inbox migration manifest count' >&2; exit 1; }
[[ "${#inbox_exclude_args[@]}" -eq $((2 * inbox_migration_count)) ]] || { echo "Expected $((2 * inbox_migration_count)) Inbox migration exclude arguments, received ${#inbox_exclude_args[@]}" >&2; exit 1; }
node scripts/ci/provision-disposable-stack.mjs --api-port 55421 --db-port 55422 "${inbox_exclude_args[@]}"
set -a
source "$lane_env"
set +a
if [[ -n "$original_env" ]]; then cat "$lane_env" >> "$original_env"; fi
export GITHUB_ENV="$original_env"
export MESSAGING_PROVIDER=mock
mutations="${RUNNER_TEMP:-/tmp}/db-contract-pre-mutations-${HEAVY_TESTED_SHA}.json"
db_contract_cleanup
lane_env=''
node scripts/outbox-db-contract-mutations.mjs "$mutations" --phase pre
