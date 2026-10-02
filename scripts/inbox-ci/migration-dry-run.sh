#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
ASSERT=scripts/inbox-ci/migration-assertions.py
INSTALL=experiments/inbox-production-install
LOCAL=${MIGRATION_LOCAL_EXECUTION:-0}
WORK=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/inbox-migration.XXXXXX")
ORIGINAL_GITHUB_ENV=${GITHUB_ENV:-}
CATALOG_CONTAINER="inbox-catalog-${GITHUB_RUN_ID:-preflight}-${GITHUB_RUN_ATTEMPT:-1}"
export INBOX_LANE_STARTED_MS
INBOX_LANE_STARTED_MS=$(python3 -c 'import time; print(int(time.time()*1000))')
export_run_dir() {
  printf 'HEAVY_RUN_DIR=docs/performance/inbox-redesign/evidence/%s/pre-merge/%s\n' "$HEAVY_TESTED_SHA" "$GITHUB_RUN_ID" >> "$ORIGINAL_GITHUB_ENV"
}
cleanup() {
  if [[ -n "${DOCKER_SOCKET:-}" ]]; then docker --host "$DOCKER_SOCKET" rm -f "$CATALOG_CONTAINER" >/dev/null 2>&1 || true; fi
  if [[ -z "${E2E_LOCAL_WORKDIR:-}" && -f "$WORK/provision.env" ]]; then
    while IFS='=' read -r key value; do
      if [[ "$key" == E2E_LOCAL_WORKDIR ]]; then E2E_LOCAL_WORKDIR="$value"; fi
    done < "$WORK/provision.env"
  fi
  if [[ -n "${E2E_LOCAL_WORKDIR:-}" ]]; then supabase stop --workdir "$E2E_LOCAL_WORKDIR" --no-backup >/dev/null 2>&1 || true; fi
}
on_exit() {
  local status=$1 command=$2 line=$3
  trap - EXIT
  cleanup
  if [[ "$status" -eq 0 ]]; then return 0; fi
  printf 'Migration lane failed at line %s: %s (exit %s)\n' "$line" "$command" "$status" >&2
  printf 'line=%s\ncommand=%s\nexit_status=%s\n' "$line" "$command" "$status" > "$WORK/failure.log"
  for log in "$WORK"/catalog-live.txt "$WORK"/production-install-unit.txt; do
    if [[ -s "$log" ]]; then printf 'Last lines of %s:\n' "${log##*/}" >&2; tail -80 "$log" >&2; fi
  done
  if [[ "$LOCAL" == 0 && -n "${ORIGINAL_GITHUB_ENV:-}" ]]; then
    local run_dir="docs/performance/inbox-redesign/evidence/${HEAVY_TESTED_SHA:-}/pre-merge/${GITHUB_RUN_ID:-}"
    if [[ -f "$run_dir/manifest.json" ]] || node scripts/inbox-ci/write-migration-record.mjs "$WORK" --fail "$status"; then
      export_run_dir
    else
      echo 'Failed to seal migration FAIL record' >&2
    fi
  fi
  exit "$status"
}
trap 'on_exit "$?" "$BASH_COMMAND" "$LINENO"' EXIT
preflight() {
[[ "$LOCAL" == 0 || "$LOCAL" == 1 ]] || { echo 'Invalid local diagnostic mode' >&2; return 3; }
[[ "$LOCAL" != 1 || "${RUNNER_ENVIRONMENT:-}" != github-hosted ]] || { echo 'Local diagnostic refused on github-hosted runner' >&2; return 3; }
if [[ "$LOCAL" == 1 ]]; then
  [[ "${DOCKER_HOST:-}" == unix:///* && "$DOCKER_HOST" != unix:///var/run/docker.sock && -S "${DOCKER_HOST#unix://}" ]] || { echo 'Local diagnostic requires a Colima Unix DOCKER_HOST' >&2; return 3; }
  [[ "${MIGRATION_LOCAL_API_PORT:-}" =~ ^[0-9]{4,5}$ && "${MIGRATION_LOCAL_DB_PORT:-}" =~ ^[0-9]{4,5}$ ]] || { echo 'Local diagnostic ports required' >&2; return 3; }
else
  [[ "${DOCKER_HOST:-unix:///var/run/docker.sock}" == unix:///var/run/docker.sock && -S /var/run/docker.sock ]] || { echo 'Runner requires /var/run/docker.sock' >&2; return 3; }
fi
DOCKER_SOCKET=${DOCKER_HOST:-unix:///var/run/docker.sock}
API_PORT=55421 DB_PORT=55422
if [[ "$LOCAL" == 1 ]]; then API_PORT=$MIGRATION_LOCAL_API_PORT; DB_PORT=$MIGRATION_LOCAL_DB_PORT; fi
export DOCKER_SOCKET
# The local path runs only in a throwaway overlay; keep auxiliary services off
# so their fixed default ports cannot collide with unrelated local stacks.
if [[ "$LOCAL" == 1 ]]; then
  python3 - <<'PY'
from pathlib import Path
import re
p = Path('supabase/config.toml')
s = p.read_text()
for section in ('analytics', 'studio', 'local_smtp', 'edge_runtime'):
    pattern = rf'(?m)^(\[{re.escape(section)}\]\n)(?:enabled\s*=\s*(?:true|false)\n)?'
    if re.search(pattern, s):
        s = re.sub(pattern, rf'\1enabled = false\n', s, count=1)
    else:
        s += f'\n[{section}]\nenabled = false\n'
p.write_text(s)
PY
fi
python3 "$ASSERT" preflight
for required in "$INSTALL/catalog_fingerprint.py" "$INSTALL/catalog-scope.json" "$INSTALL/test_catalog_fingerprint.py" "$INSTALL/test_catalog_fingerprint_live.py" "$INSTALL/operator/concurrent-indexes.sql" "$INSTALL/operator/precondition-check.sql" "$INSTALL/operator/validate-constraints.sql"; do
  test -f "$required" || { echo "Missing checkout input: $required" >&2; return 3; }
done
if [[ "${1:-}" == --preflight-only ]]; then return 0; fi
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" || -n "${TEST_SUPABASE_URL:-}" || -n "${SUPABASE_DB_PASSWORD:-}" ]]; then
  echo 'Refusing hosted Supabase credentials in migration dry-run lane' >&2; return 3
fi
[[ -n "${RUNNER_TEMP:-}" ]] || { echo "GitHub runner scratch directory required" >&2; return 3; }
[[ -n "${GITHUB_RUN_ID:-}" ]] || { echo "workflow_dispatch run id required" >&2; return 3; }
[[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]] || { echo 'workflow_dispatch required' >&2; return 3; }
[[ "${GITHUB_REF_NAME:-}" == main ]] || { echo 'main workflow ref required' >&2; return 3; }
[[ "$(git rev-parse HEAD)" =~ ^[0-9a-f]{40}$ ]] || return 3
if [[ "$LOCAL" == 0 ]]; then
  [[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Checkout must start clean' >&2; return 3; }
fi
command -v docker >/dev/null
command -v psql >/dev/null
command -v node >/dev/null
}
preflight "$@"
if [[ "${1:-}" == --preflight-only ]]; then exit 0; fi

# W1's provisioner replays the complete checked-out history except these three.
# It must leave the disposable stack running; no hosted URL is accepted.
export GITHUB_ENV="$WORK/provision.env"
node scripts/ci/provision-disposable-stack.mjs --api-port "$API_PORT" --db-port "$DB_PORT" --exclude-migrations '2026093004*' --no-baseline-owner
if [[ -f "$GITHUB_ENV" ]]; then
  while IFS='=' read -r key value; do
    if [[ "$key" == E2E_LOCAL_WORKDIR ]]; then export E2E_LOCAL_WORKDIR="$value"; fi
  done < "$GITHUB_ENV"
fi
export GITHUB_ENV="$ORIGINAL_GITHUB_ENV"
if [[ "$LOCAL" == 1 ]]; then
  PROJECT_ID=$(sed -n 's/^project_id = "\([^"]*\)"$/\1/p' "$E2E_LOCAL_WORKDIR/supabase/config.toml")
  [[ "$PROJECT_ID" == sandra-heavy-* ]] || { echo 'Unexpected local project ID' >&2; exit 3; }
  CONTAINER="supabase_db_$PROJECT_ID"
  [[ "$(docker --host "$DOCKER_SOCKET" inspect --format '{{.State.Running}}' "$CONTAINER")" == true ]] || { echo 'Owned local DB container missing' >&2; exit 3; }
else
  DBS=()
  while IFS= read -r name; do DBS+=("$name"); done < <(docker --host "$DOCKER_SOCKET" ps --format '{{.Names}}' --filter 'name=^supabase_db_')
  [[ ${#DBS[@]} -eq 1 && ${DBS[0]} =~ ^supabase_db_[a-z0-9_-]+$ && ${DBS[0]} != *_sandra ]] || { echo 'Expected exactly one local non-Sandra supabase_db_<id> container' >&2; exit 3; }
  CONTAINER=${DBS[0]}
fi
DB_URL=$(sed -n 's/^E2E_CI_SUPABASE_DB_URL=//p' "$WORK/provision.env")
[[ "$DB_URL" == "postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres" ]] || { echo 'Provisioner did not report the requested local DB URL' >&2; exit 3; }
PORT=$DB_PORT
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres PGPASSWORD=postgres
[[ "$(psql -X -At -v ON_ERROR_STOP=1 -c 'SHOW server_version' )" == 17.* ]] || { echo 'Disposable database must run PostgreSQL 17' >&2; exit 3; }
[[ "$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version LIKE '2026093004%'" )" == 0 ]] || { echo 'Inbox migration versions already applied before rehearsal' >&2; exit 3; }
psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version' > "$WORK/pre-migration-ledger.txt"
python3 "$ASSERT" history "$WORK/pre-migration-ledger.txt"
export INBOX_SCRATCH_MODE=1 INBOX_SCRATCH_DOCKER_SOCKET="$DOCKER_SOCKET" INBOX_SCRATCH_CONTAINER="$CONTAINER" INBOX_SCRATCH_DATABASE=postgres
INBOX_SCRATCH_MARKER_TOKEN=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
export INBOX_SCRATCH_MARKER_TOKEN
psql -X -v ON_ERROR_STOP=1 -v token="$INBOX_SCRATCH_MARKER_TOKEN" <<'SQL'
CREATE SCHEMA dod5_scratch;
CREATE TABLE dod5_scratch.identity(token text NOT NULL);
INSERT INTO dod5_scratch.identity(token) VALUES (:'token');
SQL
python3 -c 'import sys; sys.path.insert(0,"experiments/inbox-production-install"); from fixture_db import guard; guard()'
python3 "$INSTALL/catalog_fingerprint.py" --check-manifest > "$WORK/catalog-manifest-check.txt"
python3 "$INSTALL/catalog_fingerprint.py" --preflight > "$WORK/catalog-pre.json"
for file in supabase/migrations/2026093004*.sql; do
  version=$(basename "$file" | cut -d_ -f1)
  name=$(basename "$file" .sql | cut -d_ -f2-)
  docker --host "$DOCKER_SOCKET" exec -i "$CONTAINER" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 < "$file" > "$WORK/apply-$version.txt"
  psql -X -v ON_ERROR_STOP=1 -v version="$version" -v name="$name" > /dev/null <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (:'version',:'name',ARRAY['W2 scratch manual apply']);
SQL
 done
python3 "$ASSERT" indexes > "$WORK/indexes.txt"
psql -X -At -v ON_ERROR_STOP=1 -f "$INSTALL/operator/precondition-check.sql" > "$WORK/index-preconditions.txt"
python3 "$ASSERT" index-preconditions "$WORK/index-preconditions.txt"
# Foundation adds this check NOT VALID; execute the reviewed operator step
# after the concurrent index preconditions have passed.
psql -X -v ON_ERROR_STOP=1 -f "$INSTALL/operator/validate-constraints.sql" > "$WORK/constraint-validation.txt"
export INBOX_CATALOG_EVIDENCE_PATH="$WORK/installed-catalog.json"
python3 "$INSTALL/verify.py" --installed > "$WORK/verify-installed.txt"
python3 "$ASSERT" verify "$WORK/verify-installed.txt"
python3 "$INSTALL/catalog_fingerprint.py" > "$WORK/catalog-post.json"
if docker --host "$DOCKER_SOCKET" exec -i "$CONTAINER" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose < supabase/migrations/20260930040000_inbox_control_foundation.sql > "$WORK/second-apply.stdout.txt" 2> "$WORK/second-apply.stderr.txt"; then
  second_status=0
else
  second_status=$?
fi
ledger=()
while IFS= read -r version; do ledger+=("$version"); done < <(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT version FROM supabase_migrations.schema_migrations WHERE version LIKE '2026093004%' ORDER BY version")
python3 "$ASSERT" second-apply "$second_status" "$WORK/second-apply.stderr.txt" "${ledger[@]}"
export INBOX_MUTATION_EVIDENCE_PATH="$WORK/mutation-cases.json"
# The reviewed fixture had this non-browser role. A fresh Supabase stack does
# not, but mutation 17c needs it to prove an unexpected direct EXECUTE grant.
# TEST and Production obtain it from the worker-role packet at
# experiments/inbox-release/generated/projection-worker-role.sql, not migrations.
psql -X -v ON_ERROR_STOP=1 <<'SQL' > "$WORK/mutation-role.txt"
DO $body$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'inbox_projection_worker') THEN
    CREATE ROLE inbox_projection_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'inbox_projection_worker'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Fixture projection worker role has unexpected privileges';
  END IF;
END
$body$;
SQL
INBOX_CATALOG_EVIDENCE_PATH="$WORK/harness-installed-catalog.json" python3 "$INSTALL/verify-mutation-harness.py" --owned-fixture > "$WORK/mutation-harness.txt"
python3 "$ASSERT" mutations "$WORK/mutation-cases.json"
python3 "$INSTALL/catalog_fingerprint.py" > "$WORK/catalog-post-harness.json"
python3 "$ASSERT" catalog-unchanged "$WORK/catalog-post.json" "$WORK/catalog-post-harness.json"
# The checkout's offline production-install suite is the reviewed 64-test
# baseline. The pre-existing scratch-mode unit tests use a Colima example
# target, so run only this offline suite with the runner flag unset.
# The Electric role tests need PostgreSQL 17 binaries; install them so those
# tests execute here, and set CI=true so they fail rather than skip if missing.
PG17_BIN="$(bash scripts/inbox-ci/install-pg17.sh)"
# LC_ALL=C mirrors the Electric test step in .github/workflows/inbox-installer.yml (env: LC_ALL: C).
env -u GITHUB_ACTIONS -u CATALOG_FINGERPRINT_SCRATCH CI=true PG17_BIN="$PG17_BIN" LC_ALL=C python3 scripts/inbox-ci/run-offline-suite.py "$INSTALL" > "$WORK/production-install-unit.txt" 2>&1
python3 "$ASSERT" offline-suite "$WORK/production-install-unit.txt"
# Live catalog mutation tests require their own blank postgres:17 database:
# Supabase already owns supabase_migrations.schema_migrations.
docker --host "$DOCKER_SOCKET" run -d --name "$CATALOG_CONTAINER" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:17 > /dev/null
CATALOG_PORT=$(docker --host "$DOCKER_SOCKET" inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$CATALOG_CONTAINER")
for _ in {1..60}; do
  if docker --host "$DOCKER_SOCKET" exec "$CATALOG_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! docker --host "$DOCKER_SOCKET" exec "$CATALOG_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
  # Surface why the blank catalog database never became ready (run 36958547185 failed here with no evidence).
  docker --host "$DOCKER_SOCKET" inspect --format 'catalog container state={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}} error={{.State.Error}}' "$CATALOG_CONTAINER" >&2 || true
  docker --host "$DOCKER_SOCKET" logs --tail 80 "$CATALOG_CONTAINER" >&2 || true
fi
docker --host "$DOCKER_SOCKET" exec "$CATALOG_CONTAINER" pg_isready -U postgres -d postgres >/dev/null
export PGPORT="$CATALOG_PORT" CATALOG_FINGERPRINT_SCRATCH=sandra-mig-r7
python3 -m unittest "$INSTALL/test_catalog_fingerprint_live.py" > "$WORK/catalog-live.txt" 2>&1
python3 "$ASSERT" catalog-live "$WORK/catalog-live.txt"
if [[ "$LOCAL" == 1 ]]; then
  echo "Local diagnostic PASS; unsealed scratch results: $WORK"
else
  [[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Rehearsal left checkout dirty before record sealing' >&2; exit 3; }
  node scripts/inbox-ci/write-migration-record.mjs "$WORK"
  export_run_dir
fi
