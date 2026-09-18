#!/usr/bin/env python3
"""Compile-only negative checks for the owned HTTP worker-role target.

No database is started here.  The test evaluates the exact database/marker
values emitted in the SQL guard, proving that a release-DB marker or a typo
cannot satisfy the generated HTTP packet.  A live native-PG proof remains a
separate runtime gate.
"""
from __future__ import annotations

import importlib.util
from pathlib import Path
import re
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load_assembler():
    path = HERE / "assemble-worker-role-packet.py"
    spec = importlib.util.spec_from_file_location("assemble_worker_role_packet", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load role packet assembler")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkerRoleTargetGuardTest(unittest.TestCase):
    def test_compiled_packet_is_http_targeted_and_wrong_marker_denies(self) -> None:
        assembler = load_assembler()
        raw = (ROOT / assembler.SOURCE_PATH).read_bytes()
        packet = assembler.compile_packet(raw)
        self.assertIn("current_database()<>'postgres'", packet)
        self.assertIn("marker='sandra-inbox-http-owned-synthetic-20260917'", packet)
        self.assertNotIn("sandra_inbox_release_20260917", packet)
        self.assertNotIn("sandra-inbox-release-owned-synthetic", packet)

        db = re.search(r"current_database\(\)<>'([^']+)'", packet).group(1)
        marker = re.search(r"identity WHERE marker='([^']+)'", packet).group(1)
        self.assertEqual((db, marker), ("postgres", "sandra-inbox-http-owned-synthetic-20260917"))

        # This mirrors the generated guard's two equality predicates.  It is a
        # negative compile proof, not a claim that native PostgreSQL ran.
        def guard_accepts(database: str, identity_marker: str) -> bool:
            return database == db and identity_marker == marker

        self.assertTrue(guard_accepts("postgres", "sandra-inbox-http-owned-synthetic-20260917"))
        self.assertFalse(guard_accepts("postgres", "sandra-inbox-release-owned-synthetic"))
        self.assertFalse(guard_accepts("sandra_inbox_release_20260917", "sandra-inbox-http-owned-synthetic-20260917"))
        self.assertFalse(guard_accepts("postgres", "sandra-inbox-http-owned-synthetic-20260916"))


if __name__ == "__main__":
    unittest.main()
