#!/usr/bin/env bash
set -euo pipefail
[[ "${E2E_DISPOSABLE_DATABASE:-}" == 1 ]]
[[ "${HEAVY_LANE:-}" == outbox ]]
[[ -z "${CI:-}" ]]
[[ "${TEST_SUPABASE_URL:-}" == http://127.0.0.1:55421 ]]
export TEST_SUPABASE_URL=http://127.0.0.1:54321
export E2E_CI_SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
export NEXT_PUBLIC_SOFTPHONE_TRANSPORT=simulated
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]]
node scripts/outbox-run-record.mjs pre-merge
