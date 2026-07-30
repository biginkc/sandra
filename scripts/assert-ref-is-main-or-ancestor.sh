#!/usr/bin/env bash
set -euo pipefail

# Refuses (non-zero exit) unless the checked-out HEAD commit is `main`
# itself or an ancestor of it. The ONLY sanctioned guard for db-migrate.yml's
# migrate-prod job (round-5 review finding P1-2).
#
# Why this exists: db-migrate.yml has `workflow_dispatch:` enabled so
# migrate-test can be manually re-run for debugging. But `workflow_dispatch`
# lets anyone with write access run the ENTIRE workflow -- including
# migrate-prod's real `supabase db push` -- against ANY branch, tag, or
# explicit commit SHA via the GitHub UI or API, not just what a branch-name
# dropdown implies. Without this check, a dispatched, unmerged branch could
# alter the migrations, the safety-gate baseline (scripts/migration-safety-baseline.json),
# or this workflow's own logic and still reach a real production push,
# entirely outside review. The migration safety gate cannot defend against
# this on its own: a dispatched branch controls the gate's own source too.
#
# Checked via `git merge-base --is-ancestor HEAD origin/main` against the
# actual commit graph, NOT a string comparison against `github.ref` --
# that catches every way workflow_dispatch can point somewhere other than
# main: an obviously different branch name, a tag, or an explicit commit SHA
# that was never merged into main at all (github.ref alone would already
# catch most of these, but the commit-graph check is the one that cannot be
# fooled by how the ref happens to be spelled).
#
# Usage (from the repository root, after a checkout with fetch-depth: 0 --
# a shallow clone may not have enough history for the ancestor walk to
# resolve correctly):
#   bash scripts/assert-ref-is-main-or-ancestor.sh
#
# Exit code 0: HEAD is main, or an ancestor of main. Safe to proceed.
# Exit code 1: HEAD is not provably part of main's history. Refuse.

# Explicit destination ref so this works regardless of whatever (possibly
# narrowed) fetch refspec the calling environment configured -- plain
# `git fetch origin main` is not guaranteed to populate
# refs/remotes/origin/main on every git/checkout-action version.
git fetch origin +refs/heads/main:refs/remotes/origin/main

RESOLVED_SHA="$(git rev-parse HEAD)"
MAIN_SHA="$(git rev-parse origin/main)"

if git merge-base --is-ancestor HEAD origin/main; then
  echo "OK: checked-out commit ($RESOLVED_SHA) is main or an ancestor of main ($MAIN_SHA)."
  exit 0
fi

echo "REFUSING: checked-out commit ($RESOLVED_SHA) is not main and not an ancestor of main ($MAIN_SHA)." >&2
echo "This job only pushes to production from what is actually on main -- workflow_dispatch can" >&2
echo "target any branch/tag/SHA, and this check exists specifically to stop an unreviewed ref" >&2
echo "(including one that edited this workflow or the safety gate itself) from reaching a real" >&2
echo "production push." >&2
exit 1
