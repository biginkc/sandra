#!/usr/bin/env bash
# Shared, disposable-only setup for W3 perf lanes. Source from a lane script.
set -euo pipefail
PERF_REPO="$(git rev-parse --show-toplevel)"
PERF_SOURCE="$PERF_REPO/experiments/inbox-production-install/perf"
PERF_MIGRATIONS_DIR="$PERF_REPO/supabase/migrations"
export PERF_REPO PERF_SOURCE PERF_MIGRATIONS_DIR
perf_preflight() {
  [[ "$(git rev-parse HEAD)" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid checkout SHA' >&2; return 1; }
  [[ -z "$(git status --porcelain)" ]] || { echo 'Dirty checkout' >&2; return 1; }
  for file in 20260929000000_inbox_control_foundation.sql 20260929000100_inbox_read_companion.sql 20260929000200_inbox_backend_operation_reply.sql; do
    test -s "$PERF_MIGRATIONS_DIR/$file" || { echo "Missing required checked-out migration: $file" >&2; return 1; }
    git ls-files --error-unmatch "supabase/migrations/$file" >/dev/null || return 1
  done
  [[ -n "${RUNNER_TEMP:-}" && "${GITHUB_ACTIONS:-}" == true ]] || { echo 'GitHub runner required' >&2; return 1; }
}
perf_start() {
  local attempt="$1" status
  PERF_STACK_ID="sandra-heavy-perf-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${attempt}"
  PERF_WORKDIR="$(mktemp -d "$RUNNER_TEMP/$PERF_STACK_ID.XXXXXX")"
  export PERF_STACK_ID PERF_WORKDIR
  supabase init --workdir "$PERF_WORKDIR" >/dev/null
  cp "$PERF_REPO/supabase/config.toml" "$PERF_WORKDIR/supabase/config.toml"
  python3 - "$PERF_WORKDIR/supabase/config.toml" "$PERF_STACK_ID" <<'PY'
import re,socket,sys
from pathlib import Path
path=Path(sys.argv[1]); value=path.read_text()
def port():
 with socket.socket() as sock:
  sock.bind(('127.0.0.1',0)); return sock.getsockname()[1]
api,db=port(),port()
while db==api: db=port()
value=re.sub(r'^project_id\s*=.*$',f'project_id = "{sys.argv[2]}"',value,flags=re.M)
value=re.sub(r'(?m)^(\[api\]\n)port\s*=\s*\d+',rf'\g<1>port = {api}',value)
value=re.sub(r'(?m)^(\[db\]\n)port\s*=\s*\d+',rf'\g<1>port = {db}',value)
path.write_text(value)
PY
  mkdir -p "$PERF_WORKDIR/supabase/migrations"
  cp "$PERF_MIGRATIONS_DIR/"*.sql "$PERF_WORKDIR/supabase/migrations/"
  for file in 20260929000000_inbox_control_foundation.sql 20260929000100_inbox_read_companion.sql 20260929000200_inbox_backend_operation_reply.sql; do
    rm "$PERF_WORKDIR/supabase/migrations/$file"
  done
  supabase start --workdir "$PERF_WORKDIR" > "$PERF_WORKDIR/start.log" 2>&1
  status="$(supabase status --workdir "$PERF_WORKDIR" --output json)"
  PERF_DATABASE_URL="$(printf '%s' "$status" | node -e 'let x="";process.stdin.on("data",d=>x+=d).on("end",()=>process.stdout.write(JSON.parse(x).DB_URL))')"
  PERF_API_URL="$(printf '%s' "$status" | node -e 'let x="";process.stdin.on("data",d=>x+=d).on("end",()=>process.stdout.write(JSON.parse(x).API_URL))')"
  PERF_SERVICE_ROLE_KEY="$(printf '%s' "$status" | node -e 'let x="";process.stdin.on("data",d=>x+=d).on("end",()=>process.stdout.write(JSON.parse(x).SERVICE_ROLE_KEY))')"
  [[ "$PERF_DATABASE_URL" == postgresql://postgres:*@127.0.0.1:*/postgres && "$PERF_API_URL" == http://127.0.0.1:* ]] || { echo 'Non-local Supabase endpoint' >&2; return 1; }
  export PERF_DATABASE_URL PERF_API_URL PERF_SERVICE_ROLE_KEY E2E_DISPOSABLE_DATABASE=1
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
  unset PERF_DATABASE_URL PERF_API_URL PERF_SERVICE_ROLE_KEY E2E_DISPOSABLE_DATABASE PERF_WORKDIR PERF_STACK_ID PERF_ORG_ID PERF_ACTOR_ID
}
