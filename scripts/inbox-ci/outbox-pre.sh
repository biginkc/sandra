#!/usr/bin/env bash
set -euo pipefail
[[ "${E2E_DISPOSABLE_DATABASE:-}" == 1 ]]
[[ "${HEAVY_LANE:-}" == outbox-pre ]]
[[ -z "${CI:-}" ]]
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
export HEAVY_PHASE=pre
google-chrome --version
export NEXT_PUBLIC_SOFTPHONE_TRANSPORT=simulated
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]]
printf 'HEAVY_RUN_DIR=docs/performance/inbox-redesign/evidence/%s/pre-merge/%s\n' "$HEAVY_TESTED_SHA" "$GITHUB_RUN_ID" >> "$GITHUB_ENV"
node scripts/outbox-run-record.mjs pre-merge
