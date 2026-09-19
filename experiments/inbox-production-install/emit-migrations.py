#!/usr/bin/env python3
"""emit-migrations.py — DoD#5 migration packaging transform.

Reads the VERIFIED generated SQL packets that are already sha256-pinned to
their own build receipts / manifests:

  - experiments/inbox-production-install/generated/*.sql   (Batch A)
  - experiments/inbox-release/generated/backend-operation-reply.sql  (Batch B)

and applies exactly ONE documented transform per file: remove the
owned-fixture guard prelude — a `DO $$ BEGIN ... END $$;` block whose sole
job is to RAISE EXCEPTION unless the statement is running against the
owned rehearsal/HTTP fixture database (`install_fixture.identity`). That
guard exists only to stop these files from ever being pointed at a real
database by accident during rehearsal; it must never ship to
supabase/migrations, where these statements are meant to run for real.

No other content is touched — everything else is copied byte-for-byte from
the verified source file. The expected guard text is hard-coded below
(three distinct variants observed across the source set); the transform
matches EXACTLY that text and fails loudly if:
  - a file expected to hold N guards has some other number of matches,
  - the guard text found does not match the expected text byte-for-byte,
  - a file NOT expected to hold a guard contains install_fixture.identity
    anyway (an unclassified/unexpected guard).

--- R1 AMENDMENT (DoD#5 defect 1, 2026-09-19) ---
The original packaging emitted `auth-upgrade.sql` plus all five
`read-upgrade-*.sql` files as migrations that run AFTER a fresh
`read-companion.sql` install. `install-read-upgrade.py`'s own docstring
says the read-upgrade set is "the reviewed alternative" path for a
database that ALREADY has an older read schema — not a chain to run on
top of a fresh install. Production has no inbox schema at all, so it
takes the fresh-install path, not the existing-schema upgrade path.

Object-level proof (every FUNCTION/GRANT/REVOKE object in all five
read-upgrade files, plus `auth-upgrade.sql`'s own `authorize()`, cross
diffed against read-companion.sql / install-candidate.sql): every single
object in these six files is BYTE-IDENTICAL (once `CREATE FUNCTION` is
normalized to `CREATE OR REPLACE FUNCTION`) to what read-companion.sql /
install-candidate.sql already creates. This is not a coincidence: both
sides are compiled from the exact same manifest chunks in
read-companion.py — `read-upgrade-current.sql` is `base` (chunks[:5]) +
the two additive entries, i.e. the same 7 manifest entries that also
produce read-companion.sql; each single-purpose read-upgrade file is one
of those same chunks re-wrapped as CREATE OR REPLACE. `auth-upgrade.sql`'s
`inbox_bridge.authorize()` body is byte-identical to the one
install-candidate.sql already installs.

There are two non-function, non-idempotent overlaps, both byte-identical
in both files: (1) manifest entry 3's own chunk (source
`04-inbox-unknown-history-setup.sql`) contains a plain
`CREATE TABLE inbox_read.unknown_history_cursors (...)` +
`ALTER TABLE ... ENABLE ROW LEVEL SECURITY` + `REVOKE ALL ON TABLE ...`,
present verbatim in BOTH read-companion.sql (as part of the 7-chunk
compile) and read-upgrade-unknown.sql (as that chunk, unwrapped —
`replace_create_function()` only rewrites `CREATE FUNCTION`, never touches
`CREATE TABLE`); (2) `unknown-retention.sql` (plain
`CREATE INDEX unknown_history_retention` + plain, non-OR-REPLACE
`CREATE FUNCTION prune_expired_unknown_cursors`), appended to BOTH
read-companion.sql's compiled output AND read-upgrade-unknown.sql. Either
duplicate non-idempotent CREATE (table or index) reproduces the 42P07 the
scratch dry run hit at read-upgrade-unknown.sql.

No genuine additive delta (category iii in the brief) and no
newer-body conflict (category ii) was found anywhere in these six files.
Per the brief's instruction, an unresolved conflict would be reported
rather than guessed at — none was found: all six files are pure
redundant re-application of what the fresh-install path already ships,
so they are DROPPED from the emitted set entirely. The fresh-install
path is exactly: install-candidate.sql, then read-companion.sql, then
Batch B's backend-operation-reply.sql.
--- end amendment ---

This script performs NO database access, NO docker, and applies nothing.
It only reads source files under this repo and writes plain .sql files
under supabase/migrations/ (plus one operator index script elsewhere).

Usage:
    python3 emit-migrations.py            # (re)write the owned output files
    python3 emit-migrations.py --check    # verify the owned output files on
                                           # disk are byte-identical to what
                                           # this script would emit; exits 1
                                           # (and prints a diff) otherwise —
                                           # this is what catches a
                                           # hand-edited migration file.
"""
from __future__ import annotations

import argparse
import difflib
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
INSTALL_GENERATED = REPO_ROOT / "experiments/inbox-production-install/generated"
RELEASE_GENERATED = REPO_ROOT / "experiments/inbox-release/generated"
MIGRATIONS_DIR = REPO_ROOT / "supabase/migrations"
OPERATOR_DIR = REPO_ROOT / "experiments/inbox-production-install/operator"

# ---------------------------------------------------------------------------
# Exact guard texts (hard-coded; extracted verbatim from the source files at
# f0749a79b80a6c5fa26fa8159abfe900b6aed325). Any drift from these bytes is a
# hard failure, not a best-effort strip.
# ---------------------------------------------------------------------------

GUARD_AUTH = (
    "DO $$ BEGIN\n"
    " IF current_user<>'postgres' OR NOT (\n"
    "   (current_database()='sandra_inbox_release_20260917' AND EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-release-owned-synthetic'))\n"
    "   OR (current_database()='postgres' AND EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917'))\n"
    " ) THEN RAISE EXCEPTION 'Owned release or HTTP fixture required'; END IF;\n"
    "END $$;\n"
)

GUARD_READ_UPGRADE = (
    "DO $$ BEGIN\n"
    " IF current_user<>'postgres' OR current_database()<>'sandra_inbox_release_20260917' OR NOT EXISTS(\n"
    "  SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-release-owned-synthetic'\n"
    " ) THEN RAISE EXCEPTION 'Owned release-db fixture required'; END IF;\n"
    "END $$;\n"
)

GUARD_HTTP = (
    "DO $$ BEGIN\n"
    " IF current_user<>'postgres' OR current_database()<>'postgres' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='sandra-inbox-http-owned-synthetic-20260917') THEN RAISE EXCEPTION 'Owned HTTP fixture required';END IF;\n"
    "END $$;\n"
)

# ---------------------------------------------------------------------------
# File specs: (source path, output migration filename, guard text or None,
# expected occurrence count of that guard in the source file).
#
# Ordering matches the dependency order established by the compiler itself
# (install-candidate.sql creates inbox_control/inbox_bridge before anything
# else references them, including read-companion.sql's calls to
# inbox_bridge.authorize_serving(); Batch B calls inbox_control.admit_command(),
# which only install-candidate.sql defines, so Batch B must land after all of
# Batch A). Per the R1 amendment above, `auth-upgrade.sql` and all five
# `read-upgrade-*.sql` files are DROPPED — they are the reviewed alternative
# path for an existing-schema install, not part of a fresh install, and every
# object in them is byte-identical to what install-candidate.sql /
# read-companion.sql already create.
# ---------------------------------------------------------------------------

BATCH_A = [
    dict(
        source=INSTALL_GENERATED / "install-candidate.sql",
        output="20260919120000_inbox_control_foundation.sql",
        guard=None,
        count=0,
    ),
    dict(
        source=INSTALL_GENERATED / "read-companion.sql",
        output="20260919120100_inbox_read_companion.sql",
        guard=None,
        count=0,
    ),
]

BATCH_B = [
    dict(
        source=RELEASE_GENERATED / "backend-operation-reply.sql",
        output="20260919120200_inbox_backend_operation_reply.sql",
        guard=GUARD_HTTP,
        count=10,
    ),
]

FILE_SPECS = BATCH_A + BATCH_B

# Files that were part of the original (R1) emitted set and are now
# deliberately dropped by the amendment above. --check treats any of these
# still sitting in supabase/migrations/ as stale, same as any other unowned
# 2026091912*.sql file, via the existing stale-scan below — no separate
# logic needed. Listed here only for human/documentation traceability.
DROPPED_BY_R1_AMENDMENT = [
    "20260919120100_inbox_auth_bridge.sql",
    "20260919120300_inbox_read_upgrade_current.sql",
    "20260919120400_inbox_read_upgrade_selection_review.sql",
    "20260919120500_inbox_read_upgrade_sync_authority.sql",
    "20260919120600_inbox_read_upgrade_unknown.sql",
    "20260919120700_inbox_read_upgrade_workset_updates.sql",
]

# Statements that must never appear in emitted migrations. Note: we check
# for the actual DDL ("CREATE INDEX CONCURRENTLY"), not the bare word —
# read-companion.sql legitimately contains an explanatory comment that says
# "...create this index CONCURRENTLY outside its transaction" documenting
# why that index was carved out into read-index-01.sql instead.
FORBIDDEN_SUBSTRINGS = [
    "CREATE INDEX CONCURRENTLY",
    "install_fixture",
    "inbox_t2_fixture",
    "sandra_inbox_release_20260917",
    "sandra-inbox-release-owned-synthetic",
    "sandra-inbox-http-owned-synthetic-20260917",
]


class EmitError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Non-idempotent object collision check (DoD#5 defect 1, new guard).
#
# `CREATE OR REPLACE FUNCTION` is safe to repeat. `CREATE TABLE`,
# `CREATE INDEX` (non-CONCURRENTLY; CONCURRENTLY is separately forbidden
# above), `CREATE TYPE`, `CREATE SCHEMA` and a bare `CREATE FUNCTION`
# (no OR REPLACE) are NOT — running one twice against the same database is
# exactly the 42P07 duplicate_object failure this amendment exists to catch
# (it is what read-upgrade-unknown.sql's re-application of
# unknown-retention.sql's plain `CREATE INDEX`/`CREATE FUNCTION` produced).
# This walks the emitted files in FILE_SPECS order and fails if any emitted
# migration creates, non-idempotently, an object an EARLIER emitted
# migration already created non-idempotently.
# ---------------------------------------------------------------------------

_NONIDEMPOTENT_PATTERNS = {
    "TABLE": re.compile(r"\bCREATE\s+TABLE\s+(?!IF\s+NOT\s+EXISTS\b)([\w.]+)", re.IGNORECASE),
    "INDEX": re.compile(r"\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+(\w+)\s+ON\b", re.IGNORECASE),
    "TYPE": re.compile(r"\bCREATE\s+TYPE\s+([\w.]+)", re.IGNORECASE),
    "SCHEMA": re.compile(r"\bCREATE\s+SCHEMA\s+(?!IF\s+NOT\s+EXISTS\b)([\w.]+)", re.IGNORECASE),
    # Bare CREATE FUNCTION only -- CREATE OR REPLACE FUNCTION is idempotent
    # and must not be flagged. "REPLACE " is a fixed 8-char lookbehind.
    "FUNCTION": re.compile(r"(?<!REPLACE )\bCREATE\s+FUNCTION\s+([\w.]+)\(", re.IGNORECASE),
}


def find_nonidempotent_objects(text: str) -> dict[str, str]:
    """Return {qualified_name: kind} for every non-idempotently-created
    object in `text` (kind prefixed so e.g. an index and a table can never
    collide by bare name alone)."""
    found: dict[str, str] = {}
    for kind, pattern in _NONIDEMPOTENT_PATTERNS.items():
        for m in pattern.finditer(text):
            found[f"{kind}:{m.group(1).lower()}"] = kind
    return found


def assert_no_cross_file_object_collisions(emitted: dict[str, str]) -> None:
    """Walk emitted files in FILE_SPECS order; fail if a later file
    non-idempotently re-creates an object an earlier file already created
    non-idempotently."""
    seen: dict[str, str] = {}  # object key -> filename that first created it
    for spec in FILE_SPECS:
        name = spec["output"]
        if name not in emitted:
            continue
        for key in find_nonidempotent_objects(emitted[name]):
            if key in seen:
                raise EmitError(
                    f"{name}: non-idempotently re-creates {key}, already "
                    f"non-idempotently created by {seen[key]} earlier in the "
                    f"emitted migration order -- this is the class of bug "
                    f"(42P07 duplicate_object) that motivated the R1 "
                    f"amendment; refusing to emit"
                )
            seen[key] = name


def apply_transform(spec: dict) -> str:
    """Read spec['source'] and return the byte-stable emitted text."""
    src = spec["source"]
    if not src.is_file():
        raise EmitError(f"missing verified source file: {src}")
    text = src.read_text()

    guard = spec["guard"]
    expected_count = spec["count"]

    if guard is None:
        # This file is not expected to carry a fixture-DB guard at all.
        # If it does, that is an unclassified/unexpected guard — stop.
        if "install_fixture.identity" in text:
            raise EmitError(
                f"{src.name}: unexpected fixture guard found in a file with "
                f"no expected guard — refusing to guess, STOP and report"
            )
        return text

    actual_count = text.count(guard)
    if actual_count != expected_count:
        raise EmitError(
            f"{src.name}: expected {expected_count} occurrence(s) of the "
            f"documented guard text, found {actual_count} — guard text "
            f"differs from what emit-migrations.py expects (or is missing). "
            f"Refusing to strip a guard it cannot exact-match."
        )

    emitted = text.replace(guard, "")

    # Sanity: after removing the exact number of expected occurrences, no
    # trace of the fixture-guard machinery should remain in this file.
    if "install_fixture.identity" in emitted:
        raise EmitError(
            f"{src.name}: install_fixture.identity still present after "
            f"removing {actual_count} expected guard(s) — a guard variant "
            f"this script doesn't know about is present"
        )

    return emitted


def assert_prod_safe(name: str, text: str) -> None:
    for needle in FORBIDDEN_SUBSTRINGS:
        if needle in text:
            raise EmitError(f"{name}: forbidden substring {needle!r} present in emitted migration")

    # serving_enabled / command_admission.enabled must never be flipped true
    # by anything this script emits. The only legitimate appearances are:
    #   serving_enabled boolean NOT NULL DEFAULT false   (column definition)
    #   AND serving_enabled)                              (a read check)
    #   SET serving_enabled=false                         (kill switch, not here)
    for lineno, line in enumerate(text.splitlines(), start=1):
        stripped = line.replace(" ", "")
        if "serving_enabled=true" in stripped or "servingenabled=true" in stripped.lower().replace("_", ""):
            raise EmitError(f"{name}:{lineno}: statement sets serving_enabled=true")
        if "commandadmission" in stripped.lower().replace("_", "") and "enabled=true" in stripped:
            raise EmitError(f"{name}:{lineno}: statement enables command_admission")


def compute_emitted() -> dict[str, str]:
    """Return {output_filename: emitted_text} for every owned file."""
    out: dict[str, str] = {}
    for spec in FILE_SPECS:
        text = apply_transform(spec)
        assert_prod_safe(spec["output"], text)
        out[spec["output"]] = text
    assert_no_cross_file_object_collisions(out)
    return out


def owned_filenames() -> list[str]:
    return [spec["output"] for spec in FILE_SPECS]


def write_mode() -> int:
    emitted = compute_emitted()
    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    for name, text in emitted.items():
        (MIGRATIONS_DIR / name).write_text(text)
        print(f"wrote {MIGRATIONS_DIR / name}")
    print(f"emitted {len(emitted)} migration file(s)")
    return 0


def check_mode() -> int:
    emitted = compute_emitted()
    problems: list[str] = []
    for name, expected_text in emitted.items():
        path = MIGRATIONS_DIR / name
        if not path.is_file():
            problems.append(f"MISSING on disk: {name}")
            continue
        actual_text = path.read_text()
        if actual_text != expected_text:
            problems.append(f"DIFFERS: {name}")
            diff = difflib.unified_diff(
                expected_text.splitlines(keepends=True),
                actual_text.splitlines(keepends=True),
                fromfile=f"expected/{name}",
                tofile=f"disk/{name}",
            )
            problems.extend(line.rstrip("\n") for line in diff)

    # Also flag any owned filename present on disk that we didn't just
    # generate (stale output from a previous, now-different spec set).
    owned = set(owned_filenames())
    if MIGRATIONS_DIR.is_dir():
        for path in MIGRATIONS_DIR.glob("2026091912*.sql"):
            if path.name not in owned:
                problems.append(f"STALE (no longer emitted by this script): {path.name}")

    if problems:
        print("emit-migrations.py --check FAILED:", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        return 1

    print(f"--check OK: {len(emitted)} migration file(s) match byte-for-byte")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true", help="verify supabase/migrations/ matches emitted output; do not write")
    args = parser.parse_args()

    try:
        if args.check:
            return check_mode()
        return write_mode()
    except EmitError as exc:
        print(f"emit-migrations.py: FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
