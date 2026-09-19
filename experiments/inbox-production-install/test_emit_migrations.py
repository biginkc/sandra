#!/usr/bin/env python3
"""Mutation-meaningful unit tests for emit-migrations.py (DoD#5, R8).

These tests exercise emit-migrations.py against COPIES of the verified
source tree (never the real repo files) so they can safely mutate guard
text and hand-edit emitted migrations without touching anything real.

Run: python3 experiments/inbox-production-install/test_emit_migrations.py
"""
from __future__ import annotations

import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
EMIT_SCRIPT = HERE / "emit-migrations.py"

SPEC = importlib.util.spec_from_file_location("emit_migrations", EMIT_SCRIPT)
assert SPEC and SPEC.loader
emit_migrations = importlib.util.module_from_spec(SPEC)
sys.modules["emit_migrations"] = emit_migrations
SPEC.loader.exec_module(emit_migrations)  # type: ignore[union-attr]


def _copy_repo_slice(dst: Path) -> None:
    """Copy just the files emit-migrations.py reads, into a scratch repo
    shaped the same way (experiments/.../generated/, supabase/migrations/)."""
    for rel in (
        "experiments/inbox-production-install/generated",
        "experiments/inbox-release/generated",
    ):
        src = REPO_ROOT / rel
        target = dst / rel
        target.mkdir(parents=True, exist_ok=True)
        for f in src.glob("*.sql"):
            shutil.copy2(f, target / f.name)
    (dst / "supabase/migrations").mkdir(parents=True, exist_ok=True)


class EmitMigrationsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.scratch = Path(self._tmp.name)
        _copy_repo_slice(self.scratch)

        # Point the module at the scratch tree instead of the real repo.
        self._orig_install = emit_migrations.INSTALL_GENERATED
        self._orig_release = emit_migrations.RELEASE_GENERATED
        self._orig_migrations = emit_migrations.MIGRATIONS_DIR
        emit_migrations.INSTALL_GENERATED = self.scratch / "experiments/inbox-production-install/generated"
        emit_migrations.RELEASE_GENERATED = self.scratch / "experiments/inbox-release/generated"
        emit_migrations.MIGRATIONS_DIR = self.scratch / "supabase/migrations"

        # Re-point every FILE_SPECS source/output at the scratch tree.
        self._orig_specs = emit_migrations.FILE_SPECS
        new_specs = []
        for spec in self._orig_specs:
            new_spec = dict(spec)
            rel_to_generated = spec["source"].name
            if "inbox-production-install" in str(spec["source"]):
                new_spec["source"] = emit_migrations.INSTALL_GENERATED / rel_to_generated
            else:
                new_spec["source"] = emit_migrations.RELEASE_GENERATED / rel_to_generated
            new_specs.append(new_spec)
        emit_migrations.FILE_SPECS = new_specs

    def tearDown(self) -> None:
        emit_migrations.INSTALL_GENERATED = self._orig_install
        emit_migrations.RELEASE_GENERATED = self._orig_release
        emit_migrations.MIGRATIONS_DIR = self._orig_migrations
        emit_migrations.FILE_SPECS = self._orig_specs
        self._tmp.cleanup()

    # -- baseline sanity -----------------------------------------------

    def test_write_then_check_passes_on_clean_tree(self) -> None:
        self.assertEqual(emit_migrations.write_mode(), 0)
        self.assertEqual(emit_migrations.check_mode(), 0)
        emitted = list(emit_migrations.MIGRATIONS_DIR.glob("*.sql"))
        self.assertEqual(len(emitted), 9)

    def test_emitted_files_contain_no_guard_or_forbidden_text(self) -> None:
        emitted = emit_migrations.compute_emitted()
        for name, text in emitted.items():
            self.assertNotIn("install_fixture", text, name)
            self.assertNotIn("CREATE INDEX CONCURRENTLY", text, name)
            self.assertNotIn("inbox_t2_fixture", text, name)

    # -- mutation demonstration 1: altering guard text must make emit FAIL

    def test_altering_a_guard_text_makes_emit_fail(self) -> None:
        # Baseline: unmutated tree emits cleanly.
        self.assertEqual(emit_migrations.write_mode(), 0)

        # Mutate the auth-upgrade.sql guard's marker string in the scratch
        # copy only (never the real repo). This simulates the guard having
        # drifted from what emit-migrations.py expects.
        target = emit_migrations.INSTALL_GENERATED / "auth-upgrade.sql"
        original = target.read_text()
        mutated = original.replace(
            "sandra-inbox-release-owned-synthetic",
            "sandra-inbox-release-owned-synthetic-MUTATED",
        )
        self.assertNotEqual(original, mutated, "mutation did not change the file")
        target.write_text(mutated)

        with self.assertRaises(emit_migrations.EmitError) as ctx:
            emit_migrations.compute_emitted()
        self.assertIn("auth-upgrade.sql", str(ctx.exception))

    def test_removing_a_guard_entirely_makes_emit_fail(self) -> None:
        target = emit_migrations.INSTALL_GENERATED / "read-upgrade-current.sql"
        original = target.read_text()
        mutated = original.replace(emit_migrations.GUARD_READ_UPGRADE, "")
        self.assertNotEqual(original, mutated)
        target.write_text(mutated)

        with self.assertRaises(emit_migrations.EmitError) as ctx:
            emit_migrations.compute_emitted()
        self.assertIn("read-upgrade-current.sql", str(ctx.exception))

    def test_unexpected_guard_in_a_no_guard_file_fails(self) -> None:
        # install-candidate.sql is expected to have NO fixture guard. If one
        # ever appears there (e.g. a future compiler regression), emit must
        # refuse to guess and stop instead of silently passing it through.
        target = emit_migrations.INSTALL_GENERATED / "install-candidate.sql"
        original = target.read_text()
        injected = original + (
            "\nDO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM install_fixture.identity) "
            "THEN RAISE EXCEPTION 'x'; END IF; END $$;\n"
        )
        target.write_text(injected)

        with self.assertRaises(emit_migrations.EmitError) as ctx:
            emit_migrations.compute_emitted()
        self.assertIn("unexpected fixture guard", str(ctx.exception))

    # -- mutation demonstration 2: hand-editing an emitted migration must
    #    make --check fail

    def test_hand_editing_an_emitted_migration_fails_check(self) -> None:
        self.assertEqual(emit_migrations.write_mode(), 0)
        self.assertEqual(emit_migrations.check_mode(), 0)

        edited = emit_migrations.MIGRATIONS_DIR / "20260919120000_inbox_control_foundation.sql"
        text = edited.read_text()
        edited.write_text(text + "\n-- hand-edited, should never be byte-stable\n")

        self.assertEqual(emit_migrations.check_mode(), 1)

    def test_deleting_an_emitted_migration_fails_check(self) -> None:
        self.assertEqual(emit_migrations.write_mode(), 0)
        target = emit_migrations.MIGRATIONS_DIR / "20260919120800_inbox_backend_operation_reply.sql"
        target.unlink()
        self.assertEqual(emit_migrations.check_mode(), 1)

    # -- forbidden-content guards

    def test_serving_enabled_true_is_rejected(self) -> None:
        # Sanity: the assert_prod_safe helper itself must refuse a statement
        # that flips serving_enabled to true, independent of any real file.
        with self.assertRaises(emit_migrations.EmitError):
            emit_migrations.assert_prod_safe(
                "synthetic.sql",
                "UPDATE inbox_control.rollout SET serving_enabled=true;",
            )

    def test_concurrently_ddl_is_rejected_but_comment_mentioning_it_is_not(self) -> None:
        with self.assertRaises(emit_migrations.EmitError):
            emit_migrations.assert_prod_safe(
                "synthetic.sql", "CREATE INDEX CONCURRENTLY foo ON bar(baz);"
            )
        # Must not false-positive on prose that merely mentions the word.
        emit_migrations.assert_prod_safe(
            "synthetic.sql", "-- this index must be built CONCURRENTLY by the operator\n"
        )


if __name__ == "__main__":
    unittest.main()
