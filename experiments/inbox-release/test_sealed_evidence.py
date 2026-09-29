#!/usr/bin/env python3
"""Mutation controls for sealed Git evidence."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from sealed_evidence import ROOT, EvidenceError, evaluate, evaluate_deploy


class SealedEvidenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Evidence Test")
        (self.repo / "base.txt").write_text("base")
        self.commit("base")
        self.sha = self.git("rev-parse", "HEAD")
        self.base_branch = self.git("branch", "--show-current")

    def git(self, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def commit(self, message: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-qm", message)

    def record(self, name="one", *, sha=None, exit_status=0, completed="2026-09-28T12:00:00Z", commit=True) -> Path:
        sha = sha or self.sha
        directory = self.repo / ROOT / sha / "pre-merge" / name
        directory.mkdir(parents=True)
        artifact = directory / "screenshots" / "O01.png"
        artifact.parent.mkdir()
        artifact.write_bytes(b"screenshot")
        relative = directory.relative_to(self.repo).as_posix()
        manifest = {
            "tested_sha": self.sha, "tier": "pre-merge", "run_id": name,
            "started_at": "2026-09-28T11:00:00Z", "completed_at": completed,
            "runner_script_sha256": "a" * 64, "fault_proxy_script_sha256": "b" * 64,
            "clean_tree": {"start": True, "end_excluding_run_dir": True, "excluded_path": relative},
            "exit_status": exit_status,
            "artifacts": {"screenshots/O01.png": hashlib.sha256(artifact.read_bytes()).hexdigest()},
        }
        (directory / "manifest.json").write_text(json.dumps(manifest))
        if commit:
            self.commit(name)
        return directory

    def assert_fails(self, phrase: str) -> None:
        with self.assertRaises(EvidenceError) as caught:
            evaluate(self.repo, self.sha, "pre-merge")
        self.assertIn(phrase, str(caught.exception))

    def test_valid_sealed_record(self) -> None:
        self.record()
        self.assertEqual(evaluate(self.repo, self.sha, "pre-merge")["status"], "PASS")

    def test_dirty_tree_at_evaluation(self) -> None:
        self.record()
        (self.repo / "base.txt").write_text("dirty")
        self.assert_fails("fully clean")

    def test_dirty_index_at_evaluation(self) -> None:
        self.record()
        (self.repo / "base.txt").write_text("staged")
        self.git("add", "base.txt")
        self.assert_fails("fully clean")

    def test_uncommitted_record(self) -> None:
        self.record(commit=False)
        self.assert_fails("fully clean")

    def test_substituted_screenshot(self) -> None:
        directory = self.record(commit=False)
        (directory / "screenshots/O01.png").write_bytes(b"substituted")
        self.commit("bad screenshot")
        self.assert_fails("artifact hash mismatch")

    def test_rewritten_record_later(self) -> None:
        directory = self.record()
        (directory / "screenshots/O01.png").write_bytes(b"rewrite")
        self.commit("rewrite")
        self.assert_fails("non-addition")

    def test_artifact_and_manifest_replaced_together(self) -> None:
        directory = self.record()
        artifact = directory / "screenshots/O01.png"
        artifact.write_bytes(b"rewrite")
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"]["screenshots/O01.png"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        self.commit("rewrite both")
        self.assert_fails("non-addition")

    def test_non_evidence_path_in_commit(self) -> None:
        self.record(commit=False)
        (self.repo / "base.txt").write_text("changed")
        self.commit("mixed")
        self.assert_fails("non-evidence path")

    def test_merge_commit(self) -> None:
        self.record("one")
        self.git("checkout", "-qb", "other", self.sha)
        self.record("other")
        self.git("checkout", "-q", self.base_branch)
        self.git("merge", "--no-ff", "-qm", "merge", "other")
        self.assert_fails("merge/root")

    def test_wrong_sha_directory(self) -> None:
        self.record(sha="c" * 40)
        self.assert_fails("wrong SHA")

    def test_latest_fail_masks_older_pass(self) -> None:
        self.record("one")
        self.record("two", exit_status=1, completed="2026-09-28T13:00:00Z")
        self.assert_fails("latest pre-merge run failed")

    def test_incomplete_run(self) -> None:
        self.record(completed=None)
        self.assert_fails("completed_at")

    def test_non_monotonic_completion(self) -> None:
        self.record("one", completed="2026-09-28T13:00:00Z")
        self.record("two", completed="2026-09-28T12:00:00Z")
        self.assert_fails("non-monotonic")

    def test_addition_inside_sealed_run(self) -> None:
        directory = self.record()
        (directory / "later.log").write_text("late")
        self.commit("late addition")
        self.assert_fails("already sealed")

    def test_ambiguous_same_commit_runs(self) -> None:
        self.record("one", commit=False)
        self.record("two", commit=False)
        self.commit("two at once")
        self.assert_fails("ambiguous")

    def test_deploy_entrypoint_fails_closed(self) -> None:
        self.record()
        with self.assertRaises(EvidenceError):
            evaluate_deploy(self.repo, self.sha, "test-env")


if __name__ == "__main__":
    unittest.main()
