#!/usr/bin/env bash
set -euo pipefail

# Refuses (non-zero exit) unless the checked-out HEAD commit is `main`
# itself or an ancestor of it.
#
# ---------------------------------------------------------------------------
# THIS SCRIPT IS DEFENSE-IN-DEPTH, NOT THE REAL PROTECTION (round-7 review)
# ---------------------------------------------------------------------------
# Round-5 review treated this script as the fix for workflow_dispatch
# reaching production. Round-6 review correctly rejected that: this script
# runs FROM the same ref it is meant to police, so an unmerged branch can
# simply delete the step that calls it, or replace its body with `exit 0`,
# before it is ever checked out and run. Round 6's replacement -- a
# job-level `if: github.event_name != 'workflow_dispatch'` inside the same
# workflow file -- was ALSO wrong, and round-7 review caught it: for
# `workflow_dispatch`, GitHub runs the workflow DEFINITION from whichever
# ref the user selects when dispatching, not from `main`. An attacker
# branch could delete that `if:` line from its own copy and dispatch
# itself, and GitHub would run the edited version with production fully
# enabled -- the exact same self-authentication problem, reintroduced one
# layer up inside the fix meant to close it. Any attempt to close this
# in-repo (hashing this file, re-fetching a known-good copy from main and
# diffing, adding yet another `if:` condition) is still code running on the
# attacker-controlled ref, so it is theatre, not a fix.
#
# The REAL fix is a file split: db-migrate-prod.yml (which runs this
# script) declares NO `workflow_dispatch:` trigger anywhere in its `on:`
# block, on any branch that could plausibly become `main`'s copy. GitHub
# only offers `workflow_dispatch` as a manually-runnable option for a
# workflow file if that trigger exists in the copy ON THE DEFAULT BRANCH --
# a branch cannot make a workflow file dispatchable by adding the trigger
# to its own copy. So there is no "Run workflow" button or API call that
# can invoke db-migrate-prod.yml against any ref, ever; it is only reachable
# via `on.workflow_run` from db-migrate-test.yml completing successfully
# with `head_branch == 'main'`. See db-migrate-prod.yml's own header for the
# full reasoning, including why that property is only as strong as branch
# protection on `main` (a force-push that reintroduced a `workflow_dispatch`
# trigger into that exact file would recreate this hole).
#
# This script still runs in db-migrate-prod.yml as a second, independent
# check against the specific commit that workflow pins (the SHA
# db-migrate-test.yml verified) -- in case the workflow_run wiring above is
# ever changed in a way that weakens those guarantees. It is not, on its
# own, what stops a dispatched or unmerged ref from reaching production.
#
# ---------------------------------------------------------------------------
# Known, undefended residual: the force-push race
# ---------------------------------------------------------------------------
# This script fetches origin/main ONCE and checks ancestry at that moment.
# The real `supabase db push` happens several steps later in the same job.
# A force-push of `main` to unrelated history in the window between those
# two points could let a commit through that was correctly refused a moment
# earlier -- normal fast-forward advancement of main is safe (see case C in
# the test file), but a rewritten history is not something an ancestry
# snapshot can catch after the fact. Re-checking immediately before the push
# narrows this window but cannot eliminate a race against an external actor
# actively rewriting the ref. The only real fix is a GitHub repo setting:
# enable "Do not allow force pushes" on the `main` branch protection rule.
# That is a platform control this script cannot simulate or substitute for.
#
# ---------------------------------------------------------------------------
# What this script DOES catch (real ancestry, not a ref-name string check)
# ---------------------------------------------------------------------------
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
