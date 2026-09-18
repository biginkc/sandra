#!/usr/bin/env python3
"""Source-only checks for the operation/reply package and execution pin.

These tests do not apply SQL, start workers, build images, or contact a
database.  Installed/runtime evidence remains a separate release gate.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
EXPECTED_COMMIT = "94bf37f8af10593be058ffd5526cc9495115cf31"
EXPECTED_PACKET_SHA256 = "10af296ef4642b9b769b12f779d8b34924c74411ad3d7683c969db2ec0e7231d"


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BackendPackagingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.assembler = load_module("assemble_backend_packet", HERE / "assemble-backend-packet.py")
        cls.gate = load_module("release_gate", HERE / "release_gate.py")
        cls.backend = json.loads((HERE / "backend-operation-reply-manifest.json").read_text())
        cls.execution = json.loads((HERE / "execution-stack-manifest.json").read_text())

    def test_default_assembler_and_generated_packet_share_reviewed_pin(self) -> None:
        self.assertEqual(self.assembler.SOURCE_COMMIT, EXPECTED_COMMIT)
        self.assertEqual(self.backend["source_commit"], EXPECTED_COMMIT)
        packet = HERE.parent / "inbox-release" / "generated" / "backend-operation-reply.sql"
        packet_hash = hashlib.sha256(packet.read_bytes()).hexdigest()
        self.assertEqual(packet_hash, EXPECTED_PACKET_SHA256)
        self.assertEqual(self.backend["sql_packet"]["sha256"], packet_hash)
        self.assertEqual(len(self.backend["sql_sources"]), 26)
        self.assertEqual(len(self.backend["runtime_sources"]), 15)

    def test_execution_pin_and_service_tags_match_backend_packet(self) -> None:
        self.assertEqual(self.execution["source_commit"], EXPECTED_COMMIT)
        self.assertEqual(self.execution["source_commit"], self.backend["source_commit"])
        expected_tag = f"release-{EXPECTED_COMMIT[:7]}"
        services = self.execution["runtime_definition"]["services"]
        for name in ("operation-worker", "reply-send-worker", "projection-worker", "relay"):
            image = services[name]["image"].split("@", 1)[0]
            self.assertEqual(image.rsplit(":", 1)[-1], expected_tag, name)
        for name in ("operation-worker", "reply-send-worker", "projection-worker"):
            self.assertIsNone(services[name]["current_image_digest"], name)

    def test_source_only_release_gate_validates_backend_and_execution_files(self) -> None:
        backend_result = self.gate.verify_backend_packet()
        execution_result = self.gate.verify_execution_stack_manifest()
        self.assertEqual(backend_result["status"], "PASS", backend_result)
        self.assertEqual(execution_result["status"], "PASS", execution_result)

    def test_acceptance_gate_counts_rows_whose_text_contains_id(self) -> None:
        result = self.gate.check_acceptance_matrix("HEAD")
        self.assertEqual(result["status"], "PASS", result)
        self.assertEqual(result["rows"], 50)


if __name__ == "__main__":
    unittest.main()
