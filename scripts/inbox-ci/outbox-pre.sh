#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/failure-exit.sh"
source "$(dirname "$0")/mapfile-compat.sh"
export HEAVY_ORIGINAL_GITHUB_ENV="${GITHUB_ENV:-}"
cleanup_lane_env() { if [[ -n "${lane_env:-}" ]]; then rm -f "$lane_env"; fi; }
trap 'heavy_lane_exit "$?" cleanup_lane_env' EXIT
[[ "${HEAVY_LANE:-}" == outbox-pre ]] || { echo 'HEAVY_LANE must be outbox-pre' >&2; exit 1; }
[[ -z "${CI:-}" ]] || { echo 'CI must be unset for the outbox-pre lane' >&2; exit 1; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Checkout must be clean before outbox-pre provisioning' >&2; exit 1; }
if [[ "$(uname)" == Darwin ]]; then [[ "$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')" -ge 8 ]] || { echo 'At least 8 GiB free disk space required' >&2; exit 1; }; fi
lane_env="$(mktemp)"
original_env="${GITHUB_ENV:-}"
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
[[ "${E2E_DISPOSABLE_DATABASE:-}" == 1 ]] || { echo 'Provisioner did not publish E2E_DISPOSABLE_DATABASE=1' >&2; exit 1; }
if [[ -n "$original_env" ]]; then cat "$lane_env" >> "$original_env"; fi
export GITHUB_ENV="$original_env"
export TEST_SUPABASE_URL=http://127.0.0.1:54321
export E2E_CI_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
export HEAVY_PHASE=pre
google-chrome --version
export NEXT_PUBLIC_SOFTPHONE_TRANSPORT=simulated
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]] || { echo 'Checkout HEAD does not match HEAVY_TESTED_SHA' >&2; exit 1; }
printf 'HEAVY_RUN_DIR=docs/performance/inbox-redesign/evidence/%s/pre-merge/%s\n' "$HEAVY_TESTED_SHA" "$GITHUB_RUN_ID" >> "$GITHUB_ENV"
node scripts/outbox-run-record.mjs pre-merge
