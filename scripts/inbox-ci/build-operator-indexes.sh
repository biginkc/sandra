#!/usr/bin/env bash
set -euo pipefail
[[ "${E2E_DISPOSABLE_DATABASE:-}" == 1 && "${E2E_CI_SUPABASE_DB_URL:-}" == postgresql://postgres:postgres@127.0.0.1:55422/postgres ]] || { echo 'Disposable database required for operator indexes' >&2; exit 3; }
install=experiments/inbox-production-install/operator
psql "$E2E_CI_SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f "$install/concurrent-indexes.sql"
preconditions=$(mktemp)
trap 'rm -f "$preconditions"' EXIT
psql "$E2E_CI_SUPABASE_DB_URL" -X -At -v ON_ERROR_STOP=1 -f "$install/precondition-check.sql" > "$preconditions"
python3 scripts/inbox-ci/migration-assertions.py index-preconditions "$preconditions"
psql "$E2E_CI_SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -f "$install/validate-constraints.sql"
