#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/failure-exit.sh"
lane_env=''
replay_work=''
drift_replay_cleanup() { [[ -z "$lane_env" ]] || rm -f "$lane_env"; [[ -z "$replay_work" ]] || rm -rf "$replay_work"; }
trap 'heavy_lane_exit "$?" drift_replay_cleanup' EXIT
[[ "${HEAVY_LANE:-}" == drift-replay ]]
[[ "$(git rev-parse HEAD)" == "${HEAVY_TESTED_SHA:-}" ]]
[[ -z "$(git status --porcelain --untracked-files=all)" ]]
[[ -n "${INBOX_DRIFT_RECORD_PATH:-}" && -f "${INBOX_DRIFT_RECORD_PATH}" ]]
[[ -n "${INBOX_CATALOG_POST_BASELINE_PATH:-}" && -f "${INBOX_CATALOG_POST_BASELINE_PATH}" ]]
lane_env="$(mktemp)"
replay_work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/inbox-drift-replay.XXXXXX")"
original_github_env="${GITHUB_ENV:-}"
export GITHUB_ENV="$lane_env"
node scripts/ci/provision-disposable-stack.mjs --api-port 55421 --db-port 55422 --exclude-migrations '2026093004*'
set -a
source "$lane_env"
set +a
if [[ -n "$original_github_env" ]]; then cat "$lane_env" >> "$original_github_env"; fi
export GITHUB_ENV="$original_github_env"
cp "$INBOX_DRIFT_RECORD_PATH" "$replay_work/drift-record.json"
cp "$INBOX_CATALOG_POST_BASELINE_PATH" "$replay_work/catalog-post-baseline.json"
export PGHOST=127.0.0.1 PGPORT=55422 PGUSER=postgres PGDATABASE=postgres PGPASSWORD=postgres
python3 experiments/inbox-production-install/catalog_fingerprint.py --preflight > "$replay_work/catalog-baseline.json"
psql -X -v ON_ERROR_STOP=1 <<'SQL'
ALTER TABLE public.message_threads ADD COLUMN IF NOT EXISTS ai_responder_debounce_token uuid;
ALTER TABLE public.message_threads ADD COLUMN IF NOT EXISTS ai_responder_debounce_until timestamptz;
ALTER TABLE public.webhook_events ADD COLUMN IF NOT EXISTS processing_lease_token uuid;
CREATE INDEX IF NOT EXISTS idx_message_threads_ai_responder_status ON public.message_threads USING btree (ai_responder_status) WHERE (ai_responder_status IS NOT NULL);
SET ROLE supabase_auth_admin;
CREATE INDEX IF NOT EXISTS idx_users_email ON auth.users USING btree (email);
CREATE INDEX IF NOT EXISTS idx_users_created_at_desc ON auth.users USING btree (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_last_sign_in_at_desc ON auth.users USING btree (last_sign_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_users_name ON auth.users USING btree (((raw_user_meta_data ->> 'name'::text))) WHERE ((raw_user_meta_data ->> 'name'::text) IS NOT NULL);
RESET ROLE;
SQL
python3 experiments/inbox-production-install/catalog_fingerprint.py > "$replay_work/catalog-pre.json"
pre_result="$(node scripts/inbox-ci/rehearse-readonly.mjs --phase pre --prepare-fixture 1 --output "$replay_work/pre-readonly.json")"
replay_org="$(node -p 'JSON.parse(process.argv[1]).org' "$pre_result")"
python3 experiments/inbox-production-install/catalog_fingerprint.py --verify-drift-record --baseline "$replay_work/catalog-baseline.json" --catalog-observation "$replay_work/catalog-pre.json" --drift-record "$replay_work/drift-record.json"
for migration in supabase/migrations/2026093004*.sql; do
  version="$(basename "$migration" | cut -d_ -f1)"
  name="$(basename "$migration" .sql | cut -d_ -f2-)"
  psql -X -v ON_ERROR_STOP=1 -f "$migration" > "$replay_work/apply-$version.txt"
  psql -X -v ON_ERROR_STOP=1 -v version="$version" -v name="$name" >/dev/null <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (:'version',:'name',ARRAY['drift replay']);
SQL
done
bash scripts/inbox-ci/build-operator-indexes.sh
python3 experiments/inbox-production-install/catalog_fingerprint.py > "$replay_work/catalog-post.json"
node scripts/inbox-ci/rehearse-readonly.mjs --phase post --org "$replay_org" --pre-file "$replay_work/pre-readonly.json" --output "$replay_work/post-readonly.json" > "$replay_work/post-rehearsal.txt"
# POST is reconstructed against the sealed disposable-post baseline with the
# exact same byte-identical record. The record remains bound to sealed PRE;
# only the baseline sections change between phases.
python3 - "$replay_work/catalog-post.json" "$replay_work/drift-record.json" "$replay_work/catalog-baseline.json" "$replay_work/catalog-post-baseline.json" <<'PY'
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('catalog_fingerprint', 'experiments/inbox-production-install/catalog_fingerprint.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
post = json.loads(Path(sys.argv[1]).read_text()); record = json.loads(Path(sys.argv[2]).read_text()); pre = json.loads(Path(sys.argv[3]).read_text()); post_base = json.loads(Path(sys.argv[4]).read_text())
expected = module.reconstruct_drift_fingerprint(post_base, record, bound_baseline_digest=pre['sha256'])
if expected['section_sha256'] != post['section_sha256'] or expected['sha256'] != post['sha256']:
    raise SystemExit('POST drift reconstruction differs from observation')
PY
INBOX_ALLOW_LOCAL_DB_SKIP=0 node --test scripts/outbox-db-contract*.test.mjs scripts/inbox-ci/*.test.mjs scripts/outbox-db-contract/tls-pooler.test.mjs > "$replay_work/contract-suite.txt"
cp "$replay_work/catalog-baseline.json" "$replay_work/catalog-baseline.txt"
node scripts/inbox-ci/write-drift-replay-record.mjs "$replay_work"
printf 'HEAVY_RUN_DIR=docs/performance/inbox-redesign/evidence/%s/pre-merge/%s\n' "$HEAVY_TESTED_SHA" "$GITHUB_RUN_ID" >> "$original_github_env"
