#!/usr/bin/env bash
set -euo pipefail

# Exercises scripts/assert-ref-is-main-or-ancestor.sh against real disposable
# local git repositories (never this repo's own history, never a hosted
# project). Proves the four cases that matter for round-5 review finding
# P1-2:
#   A. HEAD at main's own tip                          -> accepted
#   B. HEAD on a divergent branch (dispatch abuse)      -> refused
#   C. an OLD main tip, after main has advanced further -> still accepted
#   D. an explicit orphaned SHA, never merged into main -> refused
#      (simulates `workflow_dispatch` given a raw commit SHA via the API,
#      which does not require the SHA to belong to any branch at all)
#
# Run:
#   bash scripts/assert-ref-is-main-or-ancestor.test.sh

FAILURES=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/assert-ref-is-main-or-ancestor.sh"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/sandra-ref-guard-test-XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

expect() {
  local label="$1" expected_status="$2" actual_status="$3"
  if [ "$expected_status" = "$actual_status" ]; then
    echo "  PASS: $label (exit $actual_status)"
  else
    echo "  FAIL: $label (expected exit $expected_status, got $actual_status)"
    FAILURES=$((FAILURES + 1))
  fi
}

run_guard() {
  # Runs the guard against $1 (a git working copy), never exiting this test
  # script on the guard's own non-zero exit.
  local dir="$1"
  ( cd "$dir" && bash "$GUARD" ) > "$WORKDIR/last-output.txt" 2>&1
  return $?
}

git init -q --bare "$WORKDIR/origin.git"
git clone -q "$WORKDIR/origin.git" "$WORKDIR/work"
cd "$WORKDIR/work"
git config user.email "test@example.com"
git config user.name "Test"
git checkout -q -b main
echo "a" > file.txt
git add file.txt
git commit -q -m "initial"
git push -q origin main

echo "[A] HEAD at main's own tip"
git clone -q --branch main "$WORKDIR/origin.git" "$WORKDIR/checkout-a"
set +e
run_guard "$WORKDIR/checkout-a"
status=$?
set -e
expect "main tip is accepted" 0 "$status"

echo "[B] HEAD on a divergent branch (workflow_dispatch abuse)"
cd "$WORKDIR/work"
git checkout -q -b malicious-branch
echo "evil" > migration.sql
git add migration.sql
git commit -q -m "unreviewed change"
git push -q origin malicious-branch
git clone -q --branch malicious-branch "$WORKDIR/origin.git" "$WORKDIR/checkout-b"
set +e
run_guard "$WORKDIR/checkout-b"
status=$?
set -e
expect "divergent branch is refused" 1 "$status"

echo "[C] an OLD main tip, after main has advanced further"
cd "$WORKDIR/work"
git checkout -q main
echo "b" >> file.txt
git commit -q -am "second commit on main"
git push -q origin main
set +e
run_guard "$WORKDIR/checkout-a" # still checked out at the OLD tip
status=$?
set -e
expect "old (but real) main commit is still accepted after main advances" 0 "$status"

echo "[D] an explicit orphaned SHA, never merged into main (raw workflow_dispatch SHA)"
cd "$WORKDIR/work"
git checkout -q -b throwaway
echo "detached evil" > detached.sql
git add detached.sql
git commit -q -m "never merged into main"
DETACHED_SHA="$(git rev-parse HEAD)"
git push -q origin throwaway
git push -q origin --delete throwaway # the branch ref is gone; the commit is still reachable/fetchable
git clone -q "$WORKDIR/origin.git" "$WORKDIR/checkout-d"
cd "$WORKDIR/checkout-d"
git fetch -q origin "$DETACHED_SHA"
git checkout -q FETCH_HEAD
set +e
run_guard "$WORKDIR/checkout-d"
status=$?
set -e
expect "orphaned/never-merged SHA is refused" 1 "$status"

echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "ALL CASES PASSED"
  exit 0
else
  echo "$FAILURES CASE(S) FAILED"
  exit 1
fi
