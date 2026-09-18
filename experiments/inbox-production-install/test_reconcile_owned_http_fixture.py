#!/usr/bin/env python3
"""Source-only safety tests for the owned HTTP recovery driver."""

from __future__ import annotations

import ast
import importlib.util
import inspect
import pathlib
import sys
import unittest


HERE = pathlib.Path(__file__).resolve().parent
SOURCE = HERE / "reconcile-owned-http-fixture.py"
SPEC = importlib.util.spec_from_file_location("reconcile_owned_http_fixture", SOURCE)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules["reconcile_owned_http_fixture"] = MODULE
SPEC.loader.exec_module(MODULE)


class ReconcileOwnedHttpFixtureTests(unittest.TestCase):
    def test_module_compiles_and_apply_is_explicit(self) -> None:
        ast.parse(SOURCE.read_text())
        tree = ast.parse(SOURCE.read_text())
        apply_flags = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "add_argument"
            and any(isinstance(arg, ast.Constant) and arg.value == "--apply" for arg in node.args)
        ]
        self.assertEqual(len(apply_flags), 1)
        action = next(keyword.value for keyword in apply_flags[0].keywords if keyword.arg == "action")
        self.assertIsInstance(action, ast.Constant)
        self.assertEqual(action.value, "store_true")

    def test_database_override_is_bounded_identifier(self) -> None:
        self.assertIsNotNone(MODULE.DATABASE_RE.fullmatch("postgres"))
        self.assertIsNotNone(MODULE.DATABASE_RE.fullmatch("inbox_restore_7b83"))
        self.assertIsNone(MODULE.DATABASE_RE.fullmatch("postgres;DROP DATABASE postgres"))

    def test_sql_literal_is_injection_safe(self) -> None:
        self.assertEqual(MODULE.sql_literal("a'b"), "'a''b'")
        self.assertEqual(MODULE.sql_literal(None), "NULL")
        self.assertEqual(MODULE.sql_literal(7), "'7'")

    def test_recovery_never_names_durable_operation_or_provider_tables_for_mutation(self) -> None:
        source = SOURCE.read_text()
        mutating_functions = "\n".join(
            inspect.getsource(getattr(MODULE, name))
            for name in ("apply_break", "ensure_sender_groups", "enqueue_unknown_targets", "prune_orphan_queue", "remove_stale_derived", "mark_complete_without_serving")
        )
        for forbidden in (
            "TRUNCATE",
            "session_replication_role",
            "DROP DATABASE",
            "DELETE FROM inbox_operations",
            "DELETE FROM inbox_reply",
            "DELETE FROM public.messages",
            "DELETE FROM inbox_policy",
            "DELETE FROM inbox_message_capture.versions",
            "DELETE FROM inbox_bridge.access_epochs",
        ):
            self.assertNotIn(forbidden, mutating_functions)
        self.assertIn("PROTECTED_RELATIONS", source)
        self.assertIn("external_cache_invalidation_required", source)

    def test_stale_projection_cleanup_order_is_explicit(self) -> None:
        source = inspect.getsource(MODULE.remove_stale_derived)
        self.assertLess(source.index("DELETE FROM inbox_bridge.filter_rows"), source.index("DELETE FROM inbox_bridge.summaries"))
        self.assertIn("coalesce((r.summary->>'exists')::boolean,false)", source)
        self.assertIn("DELETE FROM inbox_message_capture.route_edges", source)
        self.assertNotIn("DELETE FROM inbox_maintained.rows", source)
        verify_source = inspect.getsource(MODULE.verify_reconciled)
        self.assertIn("maintained_tombstones", verify_source)
        self.assertIn("maintained_missing_dirty", verify_source)
        self.assertIn("live_targets_missing_maintained", verify_source)

    def test_protected_snapshot_hashes_content_and_keys(self) -> None:
        source = inspect.getsource(MODULE.protected_snapshot)
        self.assertIn("array_to_string(ARRAY", source)
        self.assertIn("string_agg(h,',' ORDER BY h)", source)
        self.assertIn("::text", source)
        self.assertGreaterEqual(len(MODULE.PROTECTED_RELATIONS), 20)

    def test_collision_probe_and_idle_budget_are_required(self) -> None:
        run_source = inspect.getsource(MODULE.run)
        collision_source = inspect.getsource(MODULE.inspect_collisions)
        self.assertIn("inspect_collisions(db, args.max_batches)", run_source)
        self.assertIn("cardinality(duplicate_thread_ids)=2", collision_source)
        self.assertIn("idle_rounds >= 20", collision_source)
        self.assertIn("idle_rounds >= 20", inspect.getsource(MODULE.drain_backfill))
        self.assertIn("sender-group reconciliation exceeded bounded batch budget", inspect.getsource(MODULE.ensure_sender_groups))

    def test_generation_break_invalidates_read_state_and_keeps_serving_off(self) -> None:
        source = inspect.getsource(MODULE.apply_break)
        for table in ("inbox_read.history_cursors", "inbox_read.unknown_history_cursors", "inbox_read.receipts", "inbox_read.boundaries"):
            self.assertIn(f"DELETE FROM {table}", source)
        self.assertIn("UPDATE inbox_capture_boundary.generation SET generation=gen_random_uuid()", source)
        self.assertIn("serving_enabled=false,backfill_complete=false,reconciliation_complete=false", source)
        self.assertIn("UPDATE inbox_message_capture.dirty", source)
        self.assertIn("command admission to remain disabled", source)

    def test_dry_run_does_not_execute_apply_path(self) -> None:
        source = inspect.getsource(MODULE.run)
        self.assertIn("if not args.apply:", source)
        self.assertLess(source.index("if not args.apply:"), source.index("apply_break(db)"))


if __name__ == "__main__":
    unittest.main()
