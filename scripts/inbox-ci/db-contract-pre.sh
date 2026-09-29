#!/usr/bin/env bash
set -euo pipefail
[[ "${HEAVY_LANE:-}" == db-contract-pre ]]
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]]
[[ -z "$(git status --porcelain --untracked-files=all)" ]]
if [[ "$(uname)" == Darwin ]]; then [[ "$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')" -ge 8 ]]; fi
lane_env="$(mktemp)"
original_env="${GITHUB_ENV:-}"
trap 'rm -f "$lane_env"' EXIT
export GITHUB_ENV="$lane_env"
node scripts/ci/provision-disposable-stack.mjs --api-port 55421 --db-port 55422 --exclude-migrations '2026093002*'
set -a
source "$lane_env"
set +a
if [[ -n "$original_env" ]]; then cat "$lane_env" >> "$original_env"; fi
export GITHUB_ENV="$original_env"
export MESSAGING_PROVIDER=mock
mutations="${RUNNER_TEMP:-/tmp}/db-contract-pre-mutations-${HEAVY_TESTED_SHA}.json"
node scripts/outbox-db-contract-mutations.mjs "$mutations" --phase pre
