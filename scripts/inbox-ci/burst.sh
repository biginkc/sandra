#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/perf-common.sh"
perf_preflight
export PERF_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PERF_RUN_ROOT="$(mktemp -d "$RUNNER_TEMP/perf-burst.XXXXXX")"
verdict=PASS
trap perf_stop EXIT
for attempt in 1 2 3; do
  export PERF_RUN_DIR="$PERF_RUN_ROOT/attempt-$attempt"
  mkdir -p "$PERF_RUN_DIR"
  perf_start "$attempt"
  {
    uname -a
    if command -v lscpu >/dev/null; then lscpu; fi
    if command -v nproc >/dev/null; then nproc; fi
    if command -v free >/dev/null; then free -b; fi
  } > "$PERF_RUN_DIR/runner-hardware.txt"
  perf_seed
  psql "$PERF_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "UPDATE public.messages SET status='queued' WHERE id IN (SELECT id FROM public.messages WHERE org_id='$PERF_ORG_ID' AND direction='outbound' AND conversation_id IS NOT NULL ORDER BY id LIMIT 10200)" > "$PERF_RUN_DIR/queue-prep.txt"
  node "$PERF_SOURCE/apply.js" > "$PERF_RUN_DIR/migration-apply.log"
  perf_indexes
  psql "$PERF_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "ALTER SYSTEM SET log_lock_waits=on;" -c "ALTER SYSTEM SET deadlock_timeout='10ms';" -c "SELECT pg_reload_conf();" > "$PERF_RUN_DIR/log-config.txt"
  container="supabase_db_$PERF_STACK_ID"
  if node "$PERF_SOURCE/burst.js" > "$PERF_RUN_DIR/burst.log" 2>&1; then
    docker logs "$container" > "$PERF_RUN_DIR/pg-server.log" 2>&1
    if python3 "$PERF_SOURCE/analyze.py" "$PERF_RUN_DIR" > "$PERF_RUN_DIR/analysis.txt"; then
      echo PASS > "$PERF_RUN_DIR/verdict.txt"
    else
      verdict=FAIL; echo FAIL > "$PERF_RUN_DIR/verdict.txt"
    fi
  else
    docker logs "$container" > "$PERF_RUN_DIR/pg-server.log" 2>&1 || true
    verdict=FAIL; echo FAIL > "$PERF_RUN_DIR/verdict.txt"
  fi
  perf_stop
done
python3 "$PERF_SOURCE/record.py" "$PERF_RUN_ROOT" burst "$verdict"
[[ "$verdict" == PASS ]]
