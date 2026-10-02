#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
source scripts/inbox-ci/failure-exit.sh

lane_env=''
replay_work=''
current_workdir=''
original_github_env="${GITHUB_ENV:-}"
export HEAVY_ORIGINAL_GITHUB_ENV="$original_github_env"
export INBOX_LANE_STARTED_MS
INBOX_LANE_STARTED_MS=$(python3 -c 'import time; print(int(time.time()*1000))')

drift_replay_cleanup() {
  if [[ -n "$current_workdir" ]]; then
    supabase stop --workdir "$current_workdir" --no-backup >/dev/null 2>&1 || true
    current_workdir=''
  fi
  [[ -z "$lane_env" ]] || rm -f "$lane_env"
  [[ -z "$replay_work" ]] || rm -rf "$replay_work"
}
trap 'heavy_lane_exit "$?" drift_replay_cleanup' EXIT

[[ "${HEAVY_LANE:-}" == drift-replay ]] || { echo 'HEAVY_LANE=drift-replay required' >&2; exit 2; }
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]] || { echo 'Checkout does not match HEAVY_TESTED_SHA' >&2; exit 2; }
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Checkout must start clean' >&2; exit 2; }
[[ -n "${RUNNER_TEMP:-}" ]] || { echo 'GitHub runner scratch directory required' >&2; exit 2; }
[[ -n "${GITHUB_RUN_ID:-}" ]] || { echo 'workflow_dispatch run id required' >&2; exit 2; }
[[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]] || { echo 'workflow_dispatch required' >&2; exit 2; }
[[ "${GITHUB_REF_NAME:-}" == main ]] || { echo 'main workflow ref required' >&2; exit 2; }

declare -a TARGET_REFS=(ncsngxlcyxylaeskiteu copflsklaefwzipsrjqz)
for target_ref in "${TARGET_REFS[@]}"; do
  fixture="experiments/inbox-production-install/drift/${target_ref}.items.json"
  [[ -f "$fixture" ]] || { echo "Missing committed drift fixture for target ref ${target_ref}: ${fixture}" >&2; exit 2; }
done

lane_env="$(mktemp "${RUNNER_TEMP}/inbox-drift-replay-env.XXXXXX")"
replay_work="$(mktemp -d "${RUNNER_TEMP}/inbox-drift-replay.XXXXXX")"
stack_sourced=''

start_stack() {
  local env_file=$1 api_port=$2 db_port=$3
  # The previous stack's local TEST_SUPABASE_* values would trip the provisioner's
  # hosted-credential guard (key-name match), so clear them only once a stack of
  # ours has been sourced. Never clear before the first provision: the guard must
  # still see anything inherited from the runner.
  if [[ -n "$stack_sourced" ]]; then unset TEST_SUPABASE_URL TEST_SUPABASE_ANON_KEY TEST_SUPABASE_SERVICE_ROLE_KEY; fi
  : > "$env_file"
  export GITHUB_ENV="$env_file"
  local -a inbox_exclude_args
  inbox_exclude_args=()
  while IFS= read -r arg; do inbox_exclude_args+=("$arg"); done < <(node scripts/inbox-ci/inbox-migrations.mjs --exclude-args)
  node scripts/ci/provision-disposable-stack.mjs --api-port "$api_port" --db-port "$db_port" "${inbox_exclude_args[@]}"
  set -a
  source "$env_file"
  set +a
  stack_sourced=1
  if [[ -n "$original_github_env" ]]; then cat "$env_file" >> "$original_github_env"; fi
  export GITHUB_ENV="$original_github_env"
  current_workdir="${E2E_LOCAL_WORKDIR:-}"
  [[ "${E2E_DISPOSABLE_DATABASE:-}" == 1 ]] || { echo 'Disposable database marker missing' >&2; return 3; }
  [[ "${E2E_CI_SUPABASE_DB_URL:-}" == postgresql://postgres:postgres@127.0.0.1:*/* ]] || { echo 'Non-disposable database URL' >&2; return 3; }
  export PGHOST=127.0.0.1 PGPORT="$db_port" PGUSER=postgres PGDATABASE=postgres PGPASSWORD=postgres
}

stop_stack() {
  if [[ -n "$current_workdir" ]]; then
    supabase stop --workdir "$current_workdir" --no-backup >/dev/null 2>&1 || true
    current_workdir=''
  fi
}

apply_inbox_migrations() {
  local dir=$1
  while IFS= read -r migration; do
    local version name
    version="$(basename "$migration" | cut -d_ -f1)"
    name="$(basename "$migration" .sql | cut -d_ -f2-)"
    psql "$E2E_CI_SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f "$migration" > "$dir/apply-$version.txt"
    psql "$E2E_CI_SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v version="$version" -v name="$name" >/dev/null <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (:'version',:'name',ARRAY['drift replay']);
SQL
  done < <(node scripts/inbox-ci/inbox-migrations.mjs --files)
}

materialize_fixture() {
  local fixture=$1 dir=$2
  python3 experiments/inbox-production-install/catalog_fingerprint.py \
    --write-drift-fixture-sql --fixture "$fixture" --output "$dir/fixture.sql" --platform-output "$dir/platform-fixture.sql"
  psql "$E2E_CI_SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f "$dir/fixture.sql" > "$dir/fixture-apply.txt"
  local platform_db_url="postgresql://supabase_auth_admin:postgres@${E2E_CI_SUPABASE_DB_URL#postgresql://postgres:postgres@}"
  [[ "$platform_db_url" == postgresql://supabase_auth_admin:postgres@127.0.0.1:*/* ]] || {
    echo 'Derived platform fixture URL is not loopback-only' >&2
    return 3
  }
  if ! psql "$platform_db_url" -X -v ON_ERROR_STOP=1 -f "$dir/platform-fixture.sql" > "$dir/platform-fixture-apply.txt"; then
    echo 'supabase_auth_admin could not apply the platform fixture; refusing a supabase_admin fallback' >&2
    return 3
  fi
  local platform_owner_summary
  if ! platform_owner_summary="$(psql "$platform_db_url" -X -At -v ON_ERROR_STOP=1 <<'SQL'
SELECT count(*)::text || ':' || count(*) FILTER (WHERE pg_catalog.pg_get_userbyid(c.relowner) = 'supabase_auth_admin')::text
FROM pg_catalog.pg_index i
JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
WHERE i.indrelid = 'auth.users'::regclass
  AND c.relname IN (
    'idx_users_created_at_desc',
    'idx_users_email',
    'idx_users_last_sign_in_at_desc',
    'idx_users_name'
  );
SQL
)"; then
    echo 'Could not verify platform fixture index ownership' >&2
    return 3
  fi
  [[ "$platform_owner_summary" == '4:4' ]] || {
    echo "Platform fixture index ownership mismatch: expected 4:4, got ${platform_owner_summary}" >&2
    return 3
  }
  printf 'Platform fixture index ownership target=%s summary=%s\n' "$(basename "$dir")" "$platform_owner_summary"
}

baseline_dir="$replay_work/baseline"
mkdir -p "$baseline_dir"
start_stack "$replay_work/baseline.env" 55421 55422
python3 experiments/inbox-production-install/catalog_fingerprint.py --preflight > "$baseline_dir/catalog-pre.json"
apply_inbox_migrations "$baseline_dir"
bash scripts/inbox-ci/build-operator-indexes.sh > "$baseline_dir/operator-indexes.txt"
python3 experiments/inbox-production-install/catalog_fingerprint.py > "$baseline_dir/catalog-post.json"
cp "$baseline_dir/catalog-pre.json" "$replay_work/catalog-pre.json"
cp "$baseline_dir/catalog-post.json" "$replay_work/catalog-post.json"
stop_stack

# Per-target scratch paths use a neutral index, never the project ref: start_stack
# exports GITHUB_ENV=<env file>, and provision-disposable-stack.mjs rightly refuses
# any environment value containing a hosted project ref.
target_index=0
for target_ref in "${TARGET_REFS[@]}"; do
  target_index=$((target_index + 1))
  target_dir="$replay_work/target-$target_index"
  mkdir -p "$target_dir"
  fixture="experiments/inbox-production-install/drift/${target_ref}.items.json"
  start_stack "$replay_work/target-$target_index.env" 55421 55422
  python3 experiments/inbox-production-install/catalog_fingerprint.py --preflight > "$target_dir/catalog-clean.json"
  python3 - "$replay_work/catalog-pre.json" "$target_dir/catalog-clean.json" <<'PY'
import json
import sys
from pathlib import Path
expected = json.loads(Path(sys.argv[1]).read_text())
actual = json.loads(Path(sys.argv[2]).read_text())
if expected.get('sha256') != actual.get('sha256') or expected.get('section_sha256') != actual.get('section_sha256'):
    raise SystemExit('Disposable PRE baseline differs from the derived replay baseline')
PY
  materialize_fixture "$fixture" "$target_dir"
  python3 experiments/inbox-production-install/catalog_fingerprint.py > "$target_dir/catalog-pre.json"
  pre_result="$target_dir/pre-result.json"
  node scripts/inbox-ci/rehearse-readonly.mjs --phase pre --prepare-fixture 1 --output "$target_dir/pre-readonly.json" > "$pre_result"
  replay_org="$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).org' "$pre_result")"
  MESSAGING_PROVIDER=mock INBOX_ALLOW_LOCAL_DB_SKIP=0 node scripts/outbox-db-contract-mutations.mjs "$target_dir/contract-pre.json" --phase pre > "$target_dir/contract-pre.txt"
  apply_inbox_migrations "$target_dir"
  bash scripts/inbox-ci/build-operator-indexes.sh > "$target_dir/operator-indexes.txt"
  python3 experiments/inbox-production-install/catalog_fingerprint.py > "$target_dir/catalog-post.json"
  node scripts/inbox-ci/rehearse-readonly.mjs --phase post --org "$replay_org" --pre-file "$target_dir/pre-readonly.json" --output "$target_dir/post-readonly.json" > "$target_dir/post-result.txt"
  MESSAGING_PROVIDER=mock INBOX_ALLOW_LOCAL_DB_SKIP=0 node scripts/outbox-db-contract-mutations.mjs "$target_dir/contract-post.json" --phase post > "$target_dir/contract-post.txt"
  python3 experiments/inbox-production-install/catalog_fingerprint.py \
    --write-drift-record --catalog-observation "$target_dir/catalog-pre.json" --baseline "$replay_work/catalog-pre.json" \
    --fixture "$fixture" --target-ref "$target_ref" --candidate-sha "$HEAVY_TESTED_SHA" --output "$target_dir/drift-record.json"
  python3 - "$target_dir/catalog-post.json" "$target_dir/drift-record.json" "$replay_work/catalog-post.json" "$replay_work/catalog-pre.json" <<'PY'
import importlib.util
import json
import sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('catalog_fingerprint', 'experiments/inbox-production-install/catalog_fingerprint.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
post = json.loads(Path(sys.argv[1]).read_text())
record = json.loads(Path(sys.argv[2]).read_text())
post_baseline = json.loads(Path(sys.argv[3]).read_text())
pre_baseline = json.loads(Path(sys.argv[4]).read_text())
expected = module.reconstruct_drift_fingerprint(post_baseline, record, bound_baseline_digest=pre_baseline['sha256'])
if expected['section_sha256'] != post.get('section_sha256') or expected['sha256'] != post.get('sha256'):
    raise SystemExit('POST drift reconstruction differs from observation')
PY
  stop_stack
  cp "$target_dir/catalog-pre.json" "$replay_work/catalog-pre-$target_ref.json"
  cp "$target_dir/catalog-post.json" "$replay_work/catalog-post-$target_ref.json"
  cp "$target_dir/pre-readonly.json" "$replay_work/pre-readonly-$target_ref.json"
  cp "$target_dir/post-readonly.json" "$replay_work/post-readonly-$target_ref.json"
  cp "$target_dir/contract-pre.txt" "$replay_work/contract-pre-$target_ref.txt"
  cp "$target_dir/contract-post.txt" "$replay_work/contract-post-$target_ref.txt"
  cp "$target_dir/drift-record.json" "$replay_work/drift-record-$target_ref.json"
done

export GITHUB_ENV="$original_github_env"
node scripts/inbox-ci/write-drift-replay-record.mjs "$replay_work"
if [[ -n "$original_github_env" ]]; then
  printf 'HEAVY_RUN_DIR=docs/performance/inbox-redesign/evidence/%s/pre-merge/%s\n' "$HEAVY_TESTED_SHA" "$GITHUB_RUN_ID" >> "$original_github_env"
fi
