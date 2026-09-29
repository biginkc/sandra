#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
ASSERT=scripts/inbox-ci/migration-assertions.py
INSTALL=experiments/inbox-production-install
python3 "$ASSERT" preflight
for required in "$INSTALL/catalog_fingerprint.py" "$INSTALL/catalog-scope.json" "$INSTALL/test_catalog_fingerprint.py" "$INSTALL/test_catalog_fingerprint_live.py" "$INSTALL/operator/concurrent-indexes.sql" "$INSTALL/operator/precondition-check.sql"; do
  test -f "$required" || { echo "Missing checkout input: $required" >&2; exit 3; }
done
if [[ "${1:-}" == --preflight-only ]]; then exit 0; fi
if [[ -n "${SUPABASE_ACCESS_TOKEN:-}" || -n "${TEST_SUPABASE_URL:-}" || -n "${SUPABASE_DB_PASSWORD:-}" ]]; then
  echo 'Refusing hosted Supabase credentials in migration dry-run lane' >&2; exit 3
fi
: "${RUNNER_TEMP:?GitHub runner scratch directory required}"
: "${GITHUB_RUN_ID:?workflow_dispatch run id required}"
[[ "${GITHUB_EVENT_NAME:-}" == workflow_dispatch ]] || { echo 'workflow_dispatch required' >&2; exit 3; }
[[ "${GITHUB_REF_NAME:-}" == main ]] || { echo 'main workflow ref required' >&2; exit 3; }
[[ "$(git rev-parse HEAD)" =~ ^[0-9a-f]{40}$ ]] || exit 3
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Checkout must start clean' >&2; exit 3; }
command -v docker >/dev/null
command -v psql >/dev/null
command -v node >/dev/null
WORK=$(mktemp -d "$RUNNER_TEMP/inbox-migration.XXXXXX")
CATALOG_CONTAINER="inbox-catalog-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT:-1}"
cleanup() {
  docker --host unix:///var/run/docker.sock rm -f "$CATALOG_CONTAINER" >/dev/null 2>&1 || true
  if [[ -z "${E2E_LOCAL_WORKDIR:-}" && -f "$WORK/provision.env" ]]; then
    while IFS='=' read -r key value; do
      if [[ "$key" == E2E_LOCAL_WORKDIR ]]; then E2E_LOCAL_WORKDIR="$value"; fi
    done < "$WORK/provision.env"
  fi
  if [[ -n "${E2E_LOCAL_WORKDIR:-}" ]]; then supabase stop --workdir "$E2E_LOCAL_WORKDIR" --no-backup >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
export INBOX_LANE_STARTED_MS
INBOX_LANE_STARTED_MS=$(python3 -c 'import time; print(int(time.time()*1000))')

# W1's provisioner replays the complete checked-out history except these three.
# It must leave the disposable stack running; no hosted URL is accepted.
ORIGINAL_GITHUB_ENV=${GITHUB_ENV:-}
export GITHUB_ENV="$WORK/provision.env"
node scripts/ci/provision-disposable-stack.mjs --api-port 55421 --db-port 55422 --exclude-migrations '2026092900*' --no-baseline-owner
if [[ -f "$GITHUB_ENV" ]]; then
  while IFS='=' read -r key value; do
    if [[ "$key" == E2E_LOCAL_WORKDIR ]]; then export E2E_LOCAL_WORKDIR="$value"; fi
  done < "$GITHUB_ENV"
fi
export GITHUB_ENV="$ORIGINAL_GITHUB_ENV"
mapfile -t DBS < <(docker --host unix:///var/run/docker.sock ps --format '{{.Names}}' --filter 'name=^supabase_db_')
[[ ${#DBS[@]} -eq 1 && ${DBS[0]} =~ ^supabase_db_[a-z0-9_-]+$ && ${DBS[0]} != *_sandra ]] || { echo 'Expected exactly one local non-Sandra supabase_db_<id> container' >&2; exit 3; }
CONTAINER=${DBS[0]}
DB_URL=$(sed -n 's/^E2E_CI_SUPABASE_DB_URL=//p' "$WORK/provision.env")
[[ "$DB_URL" == 'postgresql://postgres:postgres@127.0.0.1:55422/postgres' ]] || { echo 'Provisioner did not report the requested local DB URL' >&2; exit 3; }
PORT=55422
export PGHOST=127.0.0.1 PGPORT="$PORT" PGUSER=postgres PGDATABASE=postgres PGPASSWORD=postgres
[[ "$(psql -X -At -v ON_ERROR_STOP=1 -c 'SHOW server_version' )" == 17.* ]] || { echo 'Disposable database must run PostgreSQL 17' >&2; exit 3; }
[[ "$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version LIKE '2026092900%'" )" == 0 ]] || { echo 'Inbox migration versions already applied before rehearsal' >&2; exit 3; }
psql -X -At -v ON_ERROR_STOP=1 -c 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version' > "$WORK/pre-migration-ledger.txt"
python3 "$ASSERT" history "$WORK/pre-migration-ledger.txt"
export INBOX_SCRATCH_MODE=1 INBOX_SCRATCH_DOCKER_SOCKET=unix:///var/run/docker.sock INBOX_SCRATCH_CONTAINER="$CONTAINER" INBOX_SCRATCH_DATABASE=postgres
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
for file in supabase/migrations/2026092900*.sql; do
  version=$(basename "$file" | cut -d_ -f1)
  name=$(basename "$file" .sql | cut -d_ -f2-)
  docker --host unix:///var/run/docker.sock exec -i "$CONTAINER" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 < "$file" > "$WORK/apply-$version.txt"
  psql -X -v ON_ERROR_STOP=1 -v version="$version" -v name="$name" > /dev/null <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (:'version',:'name',ARRAY['W2 scratch manual apply']);
SQL
 done
python3 "$ASSERT" indexes > "$WORK/indexes.txt"
psql -X -At -v ON_ERROR_STOP=1 -f "$INSTALL/operator/precondition-check.sql" > "$WORK/index-preconditions.txt"
python3 - "$WORK/index-preconditions.txt" <<'PY'
import sys
rows=[line.split('|') for line in open(sys.argv[1]) if line.strip()]
if len(rows)!=8 or any(len(row)!=4 or row[1:]!=['t','8','t'] for row in rows):
    raise SystemExit('Eight valid concurrent indexes not proven')
PY
export INBOX_CATALOG_EVIDENCE_PATH="$WORK/installed-catalog.json"
python3 "$INSTALL/verify.py" --installed > "$WORK/verify-installed.txt"
python3 "$ASSERT" verify "$WORK/verify-installed.txt"
python3 "$INSTALL/catalog_fingerprint.py" > "$WORK/catalog-post.json"
set +e
docker --host unix:///var/run/docker.sock exec -i "$CONTAINER" psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose < supabase/migrations/20260929000000_inbox_control_foundation.sql > "$WORK/second-apply.stdout.txt" 2> "$WORK/second-apply.stderr.txt"
second_status=$?
set -e
mapfile -t ledger < <(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT version FROM supabase_migrations.schema_migrations WHERE version LIKE '2026092900%' ORDER BY version")
python3 "$ASSERT" second-apply "$second_status" "$WORK/second-apply.stderr.txt" "${ledger[@]}"
export INBOX_MUTATION_EVIDENCE_PATH="$WORK/mutation-cases.json"
INBOX_CATALOG_EVIDENCE_PATH="$WORK/harness-installed-catalog.json" python3 "$INSTALL/verify-mutation-harness.py" --owned-fixture > "$WORK/mutation-harness.txt"
python3 "$ASSERT" mutations "$WORK/mutation-cases.json"
python3 "$INSTALL/catalog_fingerprint.py" > "$WORK/catalog-post-harness.json"
python3 "$ASSERT" catalog-unchanged "$WORK/catalog-post.json" "$WORK/catalog-post-harness.json"
# The checkout's offline production-install suite is the reviewed 64-test
# baseline. The pre-existing scratch-mode unit tests use a Colima example
# target, so run only this offline suite with the runner flag unset.
env -u GITHUB_ACTIONS -u CATALOG_FINGERPRINT_SCRATCH python3 scripts/inbox-ci/run-offline-suite.py "$INSTALL" > "$WORK/production-install-unit.txt" 2>&1
python3 "$ASSERT" offline-suite "$WORK/production-install-unit.txt"
# Live catalog mutation tests require their own blank postgres:17 database:
# Supabase already owns supabase_migrations.schema_migrations.
docker --host unix:///var/run/docker.sock run -d --name "$CATALOG_CONTAINER" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 postgres:17 > /dev/null
CATALOG_PORT=$(docker --host unix:///var/run/docker.sock inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$CATALOG_CONTAINER")
for _ in {1..30}; do
  if docker --host unix:///var/run/docker.sock exec "$CATALOG_CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker --host unix:///var/run/docker.sock exec "$CATALOG_CONTAINER" pg_isready -U postgres -d postgres >/dev/null
export PGPORT="$CATALOG_PORT" CATALOG_FINGERPRINT_SCRATCH=sandra-mig-r7
python3 -m unittest "$INSTALL/test_catalog_fingerprint_live.py" > "$WORK/catalog-live.txt" 2>&1
python3 "$ASSERT" catalog-live "$WORK/catalog-live.txt"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || { echo 'Rehearsal left checkout dirty before record sealing' >&2; exit 3; }
node scripts/inbox-ci/write-migration-record.mjs "$WORK"
