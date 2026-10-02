#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/failure-exit.sh"
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
while IFS= read -r arg; do inbox_exclude_args+=("$arg"); done < <(node scripts/inbox-ci/inbox-migrations.mjs --exclude-args)
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
