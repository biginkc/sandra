#!/usr/bin/env python3
"""DoD#5 defect 2: unit tests for fixture_db.py's opt-in scratch-target mode.

These tests exercise only the module-import-time refusal logic (missing
env vars, and refusing anything that resembles the real fixture) -- no
docker or database access is required or performed. They also lock in
that default (non-scratch) behavior is unchanged.

Run: python3 experiments/inbox-production-install/test_fixture_db_scratch.py
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "fixture_db.py"

_ALL_SCRATCH_VARS = (
    "INBOX_SCRATCH_MODE",
    "INBOX_SCRATCH_DOCKER_SOCKET",
    "INBOX_SCRATCH_CONTAINER",
    "INBOX_SCRATCH_DATABASE",
    "INBOX_SCRATCH_MARKER_TOKEN",
)

_VALID_SCRATCH_ENV = {
    "INBOX_SCRATCH_MODE": "1",
    "INBOX_SCRATCH_DOCKER_SOCKET": "unix:///Users/jarradhenry/.colima/sandra-dod5-scratch/docker.sock",
    "INBOX_SCRATCH_CONTAINER": "sandra-dod5-scratch-db",
    "INBOX_SCRATCH_DATABASE": "postgres",
    "INBOX_SCRATCH_MARKER_TOKEN": "dod5-scratch-test-token",
}


def _load_module(env: dict, name: str):
    """Import fixture_db.py fresh under `name`, with only `env` set among
    the scratch-relevant vars (module-level code runs on import, so a
    fresh module object per test is required)."""
    saved = {k: os.environ.get(k) for k in _ALL_SCRATCH_VARS}
    for k in _ALL_SCRATCH_VARS:
        os.environ.pop(k, None)
    os.environ.update(env)
    sys.modules.pop(name, None)
    try:
        spec = importlib.util.spec_from_file_location(name, MODULE_PATH)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)  # type: ignore[union-attr]
        return module
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        sys.modules.pop(name, None)


class DefaultBehaviorUnchangedTests(unittest.TestCase):
    def test_default_mode_matches_original_hardcoded_values(self) -> None:
        m = _load_module({}, "fdb_default_1")
        self.assertFalse(m.SCRATCH_MODE)
        self.assertEqual(m.N, "sandra-inbox-projection-t2-db")
        self.assertEqual(m.DB, "sandra_inbox_install_20260913")
        self.assertEqual(
            m.EXPECTED_MARKER, "sandra-inbox-production-candidate-owned-synthetic"
        )
        self.assertIn("inbox-redesign-20260913", m.SOCKET)

    def test_default_mode_still_enforces_database_allowlist(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            _load_module({"INBOX_RELEASE_DATABASE": "some_other_db"}, "fdb_default_2")
        self.assertIn("Refusing unapproved candidate database", str(ctx.exception))


class ScratchModeRefusalTests(unittest.TestCase):
    def test_missing_all_scratch_vars_refuses(self) -> None:
        with self.assertRaises(RuntimeError) as ctx:
            _load_module({"INBOX_SCRATCH_MODE": "1"}, "fdb_scratch_missing_all")
        msg = str(ctx.exception)
        for var in (
            "INBOX_SCRATCH_DOCKER_SOCKET",
            "INBOX_SCRATCH_CONTAINER",
            "INBOX_SCRATCH_DATABASE",
            "INBOX_SCRATCH_MARKER_TOKEN",
        ):
            self.assertIn(var, msg)

    def test_missing_one_scratch_var_refuses(self) -> None:
        env = dict(_VALID_SCRATCH_ENV)
        del env["INBOX_SCRATCH_MARKER_TOKEN"]
        with self.assertRaises(RuntimeError) as ctx:
            _load_module(env, "fdb_scratch_missing_one")
        self.assertIn("INBOX_SCRATCH_MARKER_TOKEN", str(ctx.exception))

    def test_valid_scratch_env_loads_without_touching_docker(self) -> None:
        m = _load_module(_VALID_SCRATCH_ENV, "fdb_scratch_valid")
        self.assertTrue(m.SCRATCH_MODE)
        self.assertEqual(m.N, "sandra-dod5-scratch-db")
        self.assertEqual(m.DB, "postgres")
        self.assertEqual(m.EXPECTED_MARKER, "dod5-scratch-test-token")

    def test_real_fixture_container_name_is_refused_even_in_scratch_mode(self) -> None:
        env = dict(_VALID_SCRATCH_ENV)
        env["INBOX_SCRATCH_CONTAINER"] = "sandra-inbox-projection-t2-db"
        with self.assertRaises(RuntimeError) as ctx:
            _load_module(env, "fdb_scratch_real_container")
        self.assertIn("real fixture", str(ctx.exception))

    def test_release_container_prefix_is_refused(self) -> None:
        env = dict(_VALID_SCRATCH_ENV)
        env["INBOX_SCRATCH_CONTAINER"] = "sandra-inbox-release-xyz"
        with self.assertRaises(RuntimeError) as ctx:
            _load_module(env, "fdb_scratch_release_container")
        self.assertIn("real fixture", str(ctx.exception))

    def test_real_fixture_database_name_is_refused(self) -> None:
        for db in ("sandra_inbox_install_20260913", "sandra_inbox_release_20260917"):
            env = dict(_VALID_SCRATCH_ENV)
            env["INBOX_SCRATCH_DATABASE"] = db
            with self.assertRaises(RuntimeError) as ctx:
                _load_module(env, "fdb_scratch_real_db")
            self.assertIn("real fixture", str(ctx.exception))

    def test_real_fixture_socket_is_refused(self) -> None:
        env = dict(_VALID_SCRATCH_ENV)
        env["INBOX_SCRATCH_DOCKER_SOCKET"] = (
            "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock"
        )
        with self.assertRaises(RuntimeError) as ctx:
            _load_module(env, "fdb_scratch_real_socket")
        self.assertIn("real fixture", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
