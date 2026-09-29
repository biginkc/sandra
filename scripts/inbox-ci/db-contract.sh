#!/usr/bin/env bash
set -euo pipefail
[[ "${HEAVY_LANE:-}" == db-contract ]]
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]]
[[ -z "$(git status --porcelain --untracked-files=all)" ]]
if [[ "$(uname)" == Darwin ]]; then [[ "$(df -g /System/Volumes/Data | awk 'NR==2 {print $4}')" -ge 8 ]]; fi

original_env="${GITHUB_ENV:-}"
lane_env="$(mktemp)"
cleanup() {
  if [[ -n "${E2E_LOCAL_WORKDIR:-}" ]]; then supabase stop --workdir "$E2E_LOCAL_WORKDIR" --no-backup || true; fi
  rm -f "$lane_env"
}
trap cleanup EXIT
for phase in pre post; do
  if [[ "$phase" == post ]]; then
    for version in 20260929000000 20260929000100 20260929000200; do
      if ! compgen -G "supabase/migrations/${version}_*.sql" >/dev/null; then
        node scripts/outbox-db-contract.mjs --target disposable --phase post
        exit 1
      fi
    done
    supabase stop --workdir "$E2E_LOCAL_WORKDIR" --no-backup
    unset E2E_LOCAL_WORKDIR
    : > "$lane_env"
  fi
  export GITHUB_ENV="$lane_env"
  if [[ "$phase" == pre ]]; then
    node scripts/ci/provision-disposable-stack.mjs --api-port 55421 --db-port 55422 --exclude-migrations '2026092900*'
  else
    node scripts/ci/provision-disposable-stack.mjs --api-port 55421 --db-port 55422
  fi
  set -a
  source "$lane_env"
  set +a
  export GITHUB_ENV="$original_env" MESSAGING_PROVIDER=mock
  if [[ -n "$original_env" ]]; then cat "$lane_env" >> "$original_env"; fi
  node scripts/outbox-db-contract.mjs --target disposable --phase "$phase"
done
