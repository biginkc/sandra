#!/usr/bin/env bash
# Shared, disposable-only setup for W3 perf lanes. Source from a lane script.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/failure-exit.sh"
PERF_REPO="$(git rev-parse --show-toplevel)"
PERF_SOURCE="$PERF_REPO/experiments/inbox-production-install/perf"
PERF_MIGRATIONS_DIR="$PERF_REPO/supabase/migrations"
export PERF_REPO PERF_SOURCE PERF_MIGRATIONS_DIR
perf_preflight() {
  [[ "$(git rev-parse HEAD)" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid checkout SHA' >&2; return 1; }
  if [[ "${PERF_LOCAL_EXECUTION:-}" != 1 ]]; then
    [[ -z "$(git status --porcelain)" ]] || { echo 'Dirty checkout' >&2; return 1; }
  fi
  while IFS= read -r path; do
    file="${path##*/}"
    test -s "$PERF_MIGRATIONS_DIR/$file" || { echo "Missing required checked-out migration: $file" >&2; return 1; }
    if [[ "${PERF_LOCAL_EXECUTION:-}" != 1 ]]; then
      git ls-files --error-unmatch "supabase/migrations/$file" >/dev/null || return 1
    fi
  done < <(node "$PERF_REPO/scripts/inbox-ci/inbox-migrations.mjs" --files)
  [[ -n "${RUNNER_TEMP:-}" && -n "${GITHUB_ENV:-}" && "${GITHUB_ACTIONS:-}" == true ]] || { echo 'GitHub runner required' >&2; return 1; }
}
perf_start() {
  local attempt="$1" key value
  local -a local_ports=()
  if [[ "${PERF_LOCAL_EXECUTION:-}" == 1 ]]; then
    [[ -n "${PERF_LOCAL_API_PORT:-}" && -n "${PERF_LOCAL_DB_PORT:-}" ]] || { echo 'Local diagnostic ports required' >&2; return 1; }
    local_ports=(--api-port "$PERF_LOCAL_API_PORT" --db-port "$PERF_LOCAL_DB_PORT")
  fi
  PERF_STACK_ID="sandra-heavy-perf-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${attempt}"
  export PERF_STACK_ID
  local -a inbox_exclude_args
  inbox_exclude_args=()
  while IFS= read -r arg; do inbox_exclude_args+=("$arg"); done < <(node "$PERF_REPO/scripts/inbox-ci/inbox-migrations.mjs" --exclude-args)
  node "$PERF_REPO/scripts/ci/provision-disposable-stack.mjs" \
    --no-baseline-owner \
    "${local_ports[@]+"${local_ports[@]}"}" \
    "${inbox_exclude_args[@]}"
  while IFS='=' read -r key value; do
    case "$key" in
      E2E_LOCAL_WORKDIR|E2E_DISPOSABLE_DATABASE|TEST_SUPABASE_URL|TEST_SUPABASE_SERVICE_ROLE_KEY|E2E_CI_SUPABASE_DB_URL)
        export "$key=$value" ;;
    esac
  done < "$GITHUB_ENV"
  PERF_WORKDIR="$E2E_LOCAL_WORKDIR"
  PERF_DB_CONTAINER="supabase_db_$(sed -n 's/^project_id = "\([^"]*\)"$/\1/p' "$PERF_WORKDIR/supabase/config.toml")"
  PERF_DATABASE_URL="$E2E_CI_SUPABASE_DB_URL"
  PERF_API_URL="$TEST_SUPABASE_URL"
  PERF_SERVICE_ROLE_KEY="$TEST_SUPABASE_SERVICE_ROLE_KEY"
  [[ "$PERF_DATABASE_URL" == postgresql://postgres:*@127.0.0.1:*/postgres && "$PERF_API_URL" == http://127.0.0.1:* ]] || { echo 'Non-local Supabase endpoint' >&2; return 1; }
  [[ "$PERF_DB_CONTAINER" == supabase_db_sandra-heavy-* ]] || { echo 'Unexpected owned database container' >&2; return 1; }
  export PERF_DATABASE_URL PERF_API_URL PERF_SERVICE_ROLE_KEY PERF_DB_CONTAINER E2E_DISPOSABLE_DATABASE=1
  node "$PERF_SOURCE/init-fixture.mjs"
  PERF_ORG_ID="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PERF_RUN_DIR+"/identity.json")).org')"
  PERF_ACTOR_ID="$(node -p 'JSON.parse(require("fs").readFileSync(process.env.PERF_RUN_DIR+"/identity.json")).actor')"
  export PERF_ORG_ID PERF_ACTOR_ID
}
perf_seed() {
  local manifest
  manifest="$(python3 "$PERF_SOURCE/seed.py" --prepare)"
  for i in $(seq 1 12); do
    python3 "$PERF_SOURCE/seed.py" --apply --manifest "$manifest" --actor-user-id "$PERF_ACTOR_ID" --max-batches 100 >> "$PERF_RUN_DIR/seed.log"
  done
  python3 - "$PERF_RUN_DIR/seed.log" <<'PY'
import json,sys
from pathlib import Path
r=json.loads(Path(sys.argv[1]).read_text().splitlines()[-1]);assert r['progress']==120000 and r['canonical_counts']['messages']==147000,r
PY
}
perf_indexes() {
  local file="$PERF_REPO/experiments/inbox-production-install/operator/concurrent-indexes.sql"
  test -s "$file"
  psql "$PERF_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$file" > "$PERF_RUN_DIR/index-builds.log" 2>&1
  psql "$PERF_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -f "$PERF_REPO/experiments/inbox-production-install/operator/precondition-check.sql" > "$PERF_RUN_DIR/precondition.txt"
  [[ "$(wc -l < "$PERF_RUN_DIR/precondition.txt" | tr -d ' ')" == 8 ]] || { echo 'Index precondition row count' >&2; return 1; }
  awk -F '|' '$2 != "t" || $3 != 8 || $4 != "t" {exit 1}' "$PERF_RUN_DIR/precondition.txt"
}
perf_stop() {
  if [[ -n "${PERF_WORKDIR:-}" ]]; then
    supabase stop --workdir "$PERF_WORKDIR" --no-backup >/dev/null 2>&1 || { echo "Failed to stop owned stack $PERF_STACK_ID" >&2; return 1; }
  fi
  unset PERF_DATABASE_URL PERF_API_URL PERF_SERVICE_ROLE_KEY PERF_DB_CONTAINER E2E_DISPOSABLE_DATABASE E2E_LOCAL_WORKDIR E2E_CI_SUPABASE_DB_URL TEST_SUPABASE_URL TEST_SUPABASE_SERVICE_ROLE_KEY PERF_WORKDIR PERF_STACK_ID PERF_ORG_ID PERF_ACTOR_ID
}
perf_exit() {
  local status=0
  perf_stop || status=$?
  # The lane owns and stops each stack. Prevent the workflow's final step from
  # trying to stop an already stopped stack via the provisioner's GITHUB_ENV.
  echo 'E2E_LOCAL_WORKDIR=' >> "$GITHUB_ENV" || status=$?
  return "$status"
}
