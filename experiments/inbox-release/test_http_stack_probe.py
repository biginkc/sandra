#!/usr/bin/env python3
"""Regression tests for authenticated HTTP fixture proof."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import os
import unittest
from unittest import mock


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("http_stack_probe", HERE / "http-stack-probe.py")
assert SPEC and SPEC.loader
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class HttpStackProbeTests(unittest.TestCase):
    def test_missing_credentials_are_blocked(self) -> None:
        result: dict = {"status": "PASS"}
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(probe.authenticated_credentials(result))
        self.assertEqual(result, {"status": "BLOCKED", "authenticated_rpc": "BLOCKED: credentials not supplied"})

    def test_credentials_are_returned_without_logging_them(self) -> None:
        result: dict = {"status": "PASS"}
        with mock.patch.dict(os.environ, {"INBOX_HTTP_USER_EMAIL": "owned@example.invalid", "INBOX_HTTP_USER_PASSWORD": "secret"}, clear=True):
            self.assertEqual(probe.authenticated_credentials(result), ("owned@example.invalid", "secret"))
        self.assertEqual(result, {"status": "PASS"})


if __name__ == "__main__":
    unittest.main()
