#!/usr/bin/env bash
# Source from a heavy lane after its provenance variables are available.
heavy_failure_record() {
  local status=$1 sealed_dir
  [[ "$status" -ne 0 ]] || return 0
  local env_file=${HEAVY_ORIGINAL_GITHUB_ENV:-${GITHUB_ENV:-}}
  [[ "${HEAVY_TESTED_SHA:-}" =~ ^[a-f0-9]{40}$ && "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && -n "$env_file" ]] || return 0
  sealed_dir="docs/performance/inbox-redesign/evidence/$HEAVY_TESTED_SHA/pre-merge/$GITHUB_RUN_ID"
  if [[ ! -f "$sealed_dir/manifest.json" ]]; then
    node scripts/inbox-ci/write-failure-record.mjs "$status" || return 1
  fi
  printf 'HEAVY_RUN_DIR=%s\n' "$sealed_dir" >> "$env_file"
}

heavy_lane_exit() {
  local status=$1 cleanup=${2:-} cleanup_status=0
  trap - EXIT
  if [[ -n "$cleanup" ]]; then "$cleanup" || cleanup_status=$?; fi
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then status=$cleanup_status; fi
  if [[ "$status" -ne 0 ]]; then heavy_failure_record "$status" || echo 'Failed to seal heavy lane FAIL record' >&2; fi
  exit "$status"
}
