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
EXPECTED_COMMIT = "87e0a164294b7740c38b1ca926e3503e3f3ea7eb"
EXPECTED_GRANT_FIX_COMMIT = "0b57b46e438689c2086488ab0f68b42c221bf162"
EXPECTED_PACKET_SHA256 = "c82750aecab9a2081f6a8ebbbfb1f6d7705c5649de481d8f666e1e2a881518bb"


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
        self.assertEqual(self.assembler.GRANT_FIX_COMMIT, EXPECTED_GRANT_FIX_COMMIT)
        correction = next(s for s in self.backend["sql_sources"] if s["name"] == "operation_domain_apply")["reviewed_correction"]
        self.assertEqual(correction["source_commit"], EXPECTED_GRANT_FIX_COMMIT)
        self.assertEqual(correction["sha256"], hashlib.sha256((HERE.parent / "inbox-operation-domain" / "restrictive-apply.sql").read_bytes()).hexdigest())
        packet = HERE.parent / "inbox-release" / "generated" / "backend-operation-reply.sql"
        packet_hash = hashlib.sha256(packet.read_bytes()).hexdigest()
        self.assertEqual(packet_hash, EXPECTED_PACKET_SHA256)
        self.assertEqual(self.backend["sql_packet"]["sha256"], packet_hash)
        self.assertEqual(len(self.backend["sql_sources"]), 26)
        self.assertEqual(len(self.backend["runtime_sources"]), 15)

    def test_execution_pin_and_service_tags_match_backend_packet(self) -> None:
        self.assertEqual(self.execution["source_commit"], EXPECTED_COMMIT)
        self.assertEqual(self.execution["source_commit"], self.backend["source_commit"])
        for entry in self.execution["database_role_install_order"]:
            if entry["service"] in ("operation-worker", "reply-send-worker"):
                self.assertEqual(entry["packet_sha256"], EXPECTED_PACKET_SHA256)
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

    def test_acceptance_gate_blocks_unbound_historical_rows(self) -> None:
        result = self.gate.check_acceptance_matrix("HEAD")
        self.assertEqual(result["status"], "BLOCKED", result)
        self.assertIn("candidate SHA", result["detail"])


if __name__ == "__main__":
    unittest.main()
