#!/usr/bin/env bash
# Local-only: N cold (container-restart) runs of the pinned CLI + lock probe.
# usage: SBX_WORKDIR=... cold-runs.sh <label> <N>   -> appends one JSON line per run to results/cold-<label>.jsonl
set -u
: "${SBX_WORKDIR:?SBX_WORKDIR must be set to the disposable stack workdir}"
LABEL=$1; N=$2
DB=postgresql://postgres:postgres@127.0.0.1:55329/postgres
OUT=scripts/filter-volume/results/cold-$LABEL.jsonl; : > "$OUT"
for i in $(seq 1 "$N"); do
  node scripts/filter-volume/assert-sandbox-target.mjs >/dev/null || { echo "identity check failed; aborting" >&2; exit 1; }
  docker restart supabase_db_sandra-filter-vol supabase_rest_sandra-filter-vol >/dev/null
  until psql $DB -Atc "select 1" >/dev/null 2>&1; do sleep 1; done; sleep 3
  node scripts/filter-volume/revert-cache-migrations.mjs >/dev/null
  psql $DB -qAtc "delete from messages where body='probe'; delete from tasks where title='probe'" >/dev/null
  node scripts/filter-volume/migration-lock-probe.mjs > /tmp/cold-$LABEL-$i.out 2> /tmp/cold-$LABEL-$i.err
  python3 - "$i" /tmp/cold-$LABEL-$i.out >> "$OUT" <<'PY'
import sys,json
i,f=sys.argv[1],sys.argv[2]
t=open(f).read()
try:
    d=json.loads(t[t.index('{'):t.rindex('}')+1])
    errs=list(d['insertErrorMessages'])
    for k,v in d['perWriter'].items(): errs+= [dict(e,writer=k) for e in v['errors']]
    print(json.dumps({"run":int(i),"cliExit":d['cliExit'],"errors":errs,"insMax":d['insert']['maxMs'],"readMax":d['read']['maxMs'],"propAE":d['accessExclusiveHoldMs'].get('properties',{}).get('holdMs'),"writerMax":{k:v['maxMs'] for k,v in d['perWriter'].items()},"xacts":d['distinctMigrationXactStarts'],"valid":d['distinctMigrationXactStarts']>=64}))
except Exception as e:
    print(json.dumps({"run":int(i),"harnessError":str(e),"tail":t[-300:]}))
PY
done
