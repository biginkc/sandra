#!/usr/bin/env bash
# Two-session race rehearsal for 20261031120000_homeowner_from_property_links.
# DISPOSABLE local stack only (seeds rows, re-runs the migration and rollback).
#
# Proves: a contact flagged do_not_contact by another session AFTER the
# resolver's snapshot but BEFORE the homeowner write is skipped, and the lead
# is NOT DNC-locked. Covered for both writers: fill_homeowner_from_links
# (import time) and the migration's backfill statement.
#
#   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
#     scripts/rehearse-homeowner-links-dnc-race.sh
#
# Mechanism under test: both writers lock the candidate contact FOR SHARE.
# Session A holds the contact row (UPDATE ... do_not_contact = true, not yet
# committed) while session B resolves the candidate (snapshot still sees
# do_not_contact = false), blocks on the FOR SHARE, and after A commits
# re-checks the row's newest version and drops the candidate.
set -euo pipefail
: "${DB_URL:?set DB_URL to a disposable local database}"
case "$DB_URL" in *127.0.0.1*|*localhost*) ;; *) echo "refusing non-local DB_URL" >&2; exit 2;; esac
HERE="$(cd "$(dirname "$0")/.." && pwd)"
FWD="$HERE/supabase/migrations/20261031120000_homeowner_from_property_links.sql"
RB="$HERE/supabase/rollbacks/20261031120000_homeowner_from_property_links.sql"
ORG='00000000-0000-0000-0000-000000000bbb'
# Fresh ids every run: a contact flagged do_not_contact is permanently locked
# by trigger and cannot be deleted, so the script never reuses rows.
newid() { uuidgen | tr 'A-F' 'a-f'; }
P1=$(newid); C1=$(newid); P2=$(newid); C2=$(newid)
RUN=$(printf '%04d' $((RANDOM % 10000)))
q() { psql "$DB_URL" -qAt -v ON_ERROR_STOP=1 "$@"; }

q <<SQL
insert into public.properties (id, org_id, address, state, source) values
  ('$P1', '$ORG', '1 Race St #$RUN', 'MO', 'assigns'), ('$P2', '$ORG', '2 Race St #$RUN', 'MO', 'assigns');
insert into public.contacts (id, org_id, first_name, last_name, phone_1, phone_1_type) values
  ('$C1', '$ORG', 'Race', 'One $RUN', '+1417555$RUN', 'mobile'), ('$C2', '$ORG', 'Race', 'Two $RUN', '+1417556$RUN', 'mobile');
insert into public.property_contacts (property_id, contact_id, org_id, relationship, source_identity, source_position, source_attributes) values
  ('$P1', '$C1', '$ORG', 'assigns_contact', 'assigns:1:0000aaa1', 1, '{}'),
  ('$P2', '$C2', '$ORG', 'assigns_contact', 'assigns:1:0000aaa2', 1, '{}');
SQL

race() { # $1 = contact to flip, $2 = SQL session B runs (blocks on the FOR SHARE)
  local contact="$1" b_sql="$2"
  # Session A: hold the contact row for 4s, then commit the DNC flip.
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 <<SQL &
begin;
update public.contacts set do_not_contact = true where id = '$contact';
select pg_sleep(4);
commit;
SQL
  local a_pid=$!
  sleep 1
  # Session B: resolves with do_not_contact still false in its snapshot, must wait for A, then skip.
  local started=$(date +%s)
  psql "$DB_URL" -q -v ON_ERROR_STOP=1 -c "set lock_timeout = '30s';" -f /dev/stdin <<<"$b_sql" >/dev/null
  local waited=$(( $(date +%s) - started ))
  wait "$a_pid"
  if [ "$waited" -lt 2 ]; then echo "FAIL: session B did not wait on the contact lock (waited ${waited}s)"; exit 1; fi
}

echo "1/2 import-time helper (fill_homeowner_from_links)"
race "$C1" "select public.fill_homeowner_from_links('$P1', '$ORG');"
res=$(q -c "select coalesce(homeowner_contact_id::text,'null') || ' ' || is_dnc_locked from public.properties where id='$P1'")
[ "$res" = "null false" ] || { echo "FAIL: expected no homeowner and no lock, got: $res"; exit 1; }
echo "   OK: candidate skipped, lead not locked"

echo "2/2 migration backfill statement (rollback, then forward while the flip is in flight)"
q -f "$RB" >/dev/null
race "$C2" "\\i '$FWD'"
res=$(q -c "select coalesce(homeowner_contact_id::text,'null') || ' ' || is_dnc_locked from public.properties where id='$P2'")
[ "$res" = "null false" ] || { echo "FAIL: expected no homeowner and no lock, got: $res"; exit 1; }
inledger=$(q -c "select count(*) from public.homeowner_link_backfill where property_id='$P2'")
[ "$inledger" = "0" ] || { echo "FAIL: skipped candidate must not be in the ledger"; exit 1; }
echo "   OK: candidate skipped, lead not locked, not in ledger"
echo "DNC RACE REHEARSAL OK"
