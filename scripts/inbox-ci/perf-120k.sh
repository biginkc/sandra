#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/failure-exit.sh"
perf_cleaned=0
perf_cleanup() { if [[ "$perf_cleaned" == 0 ]] && declare -F perf_exit >/dev/null; then perf_exit; fi; }
trap 'heavy_lane_exit "$?" perf_cleanup' EXIT
source "$(dirname "$0")/perf-common.sh"
perf_preflight
export PERF_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export PERF_RUN_DIR="$(mktemp -d "$RUNNER_TEMP/perf-120k.XXXXXX")"
perf_start 1
perf_seed
psql "$PERF_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -F ',' -c "SELECT relname,relfilenode FROM pg_class WHERE oid IN ('public.messages'::regclass,'public.contacts'::regclass,'public.properties'::regclass,'public.consent_events'::regclass,'public.message_threads'::regclass,'public.sms_phone_suppressions'::regclass,'public.ai_disposition_reviews'::regclass,'public.memberships'::regclass,'public.organizations'::regclass,'public.provider_sender_numbers'::regclass,'public.sequence_enrollments'::regclass) ORDER BY relname" > "$PERF_RUN_DIR/before-relfilenodes.csv"
node "$PERF_SOURCE/bench.js" baseline > "$PERF_RUN_DIR/baseline.log"
node "$PERF_SOURCE/apply.js" > "$PERF_RUN_DIR/migration-apply.log"
perf_indexes
psql "$PERF_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -F ',' -c "SELECT relname,relfilenode FROM pg_class WHERE oid IN ('public.messages'::regclass,'public.contacts'::regclass,'public.properties'::regclass,'public.consent_events'::regclass,'public.message_threads'::regclass,'public.sms_phone_suppressions'::regclass,'public.ai_disposition_reviews'::regclass,'public.memberships'::regclass,'public.organizations'::regclass,'public.provider_sender_numbers'::regclass,'public.sequence_enrollments'::regclass) ORDER BY relname" > "$PERF_RUN_DIR/after-relfilenodes.csv"
node "$PERF_SOURCE/bench.js" after > "$PERF_RUN_DIR/after.log"
if python3 "$PERF_SOURCE/analyze_120k.py" "$PERF_RUN_DIR" > "$PERF_RUN_DIR/analysis.txt"; then verdict=PASS; else verdict=FAIL; fi
perf_stop
perf_exit
perf_cleaned=1
if [[ "${PERF_LOCAL_EXECUTION:-}" == 1 ]]; then
  echo "Local diagnostic: $PERF_RUN_DIR ($verdict). No approval record."
else
  sealed_dir="$(python3 "$PERF_SOURCE/record.py" "$PERF_RUN_DIR" perf-120k "$verdict")"
  printf 'HEAVY_RUN_DIR=%s\n' "$sealed_dir" >> "$GITHUB_ENV"
fi
echo "120k synthetic measurements: $PERF_RUN_DIR ($verdict)"
[[ "$verdict" == PASS ]]
