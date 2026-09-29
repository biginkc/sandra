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

    def record(self, name="one", *, sha=None, tier="pre-merge", exit_status=0, completed="2026-09-28T12:00:00Z", observed=None, commit=True) -> Path:
        sha = sha or self.sha
        directory = self.repo / ROOT / sha / tier / name
        directory.mkdir(parents=True)
        artifact = directory / "screenshots" / "O01.png"
        artifact.parent.mkdir()
        artifact.write_bytes(b"screenshot")
        relative = directory.relative_to(self.repo).as_posix()
        manifest = {
            "tested_sha": self.sha, "tier": tier, "run_id": name,
            "started_at": "2026-09-28T11:00:00Z", "completed_at": completed,
            "runner_script_sha256": "a" * 64, "fault_proxy_script_sha256": "b" * 64,
            "clean_tree": {"start": True, "end_excluding_run_dir": True, "excluded_path": relative},
            "exit_status": exit_status,
            "artifacts": {"screenshots/O01.png": hashlib.sha256(artifact.read_bytes()).hexdigest()},
        }
        if observed is not None:
            manifest["observed_deployment"] = observed
        (directory / "manifest.json").write_text(json.dumps(manifest))
        if commit:
            self.commit(name)
        return directory

    def assert_fails(self, phrase: str) -> None:
        with self.assertRaises(EvidenceError) as caught:
            evaluate(self.repo, self.sha, "pre-merge")
        self.assertIn(phrase, str(caught.exception))

    def tamper_manifest(self, old: str, new: str) -> None:
        directory = self.record(commit=False)
        path = directory / "manifest.json"
        raw = path.read_text()
        self.assertIn(old, raw)
        path.write_text(raw.replace(old, new, 1))
        self.commit("tampered manifest")

    def test_duplicate_exit_status_rejected(self) -> None:
        self.tamper_manifest('"exit_status": 0', '"exit_status": 1, "exit_status": 0')
        self.assert_fails("duplicate JSON key: exit_status")

    def test_duplicate_identity_fields_rejected(self) -> None:
        for field, bad in (("tested_sha", "0" * 40), ("tier", "test-env"), ("run_id", "other")):
            with self.subTest(field=field):
                # Each field needs a fresh repository because the record is sealed.
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    value = {"tested_sha": case.sha, "tier": "pre-merge", "run_id": "one"}[field]
                    case.tamper_manifest(json.dumps(field) + ": " + json.dumps(value),
                                         json.dumps(field) + ": " + json.dumps(bad) + ", " + json.dumps(field) + ": " + json.dumps(value))
                    case.assert_fails("duplicate JSON key: " + field)
                finally:
                    case.doCleanups()

    def test_duplicate_artifact_path_rejected(self) -> None:
        good = hashlib.sha256(b"screenshot").hexdigest()
        old = json.dumps("screenshots/O01.png") + ": " + json.dumps(good)
        self.tamper_manifest(old, json.dumps("screenshots/O01.png") + ": " + json.dumps("0" * 64) + ", " + old)
        self.assert_fails("duplicate JSON key: screenshots/O01.png")

    def test_nested_duplicate_artifact_object_key_rejected(self) -> None:
        self.tamper_manifest('"artifacts": {',
                             '"artifact_details": [{"artifact": {"path": "wrong", "path": "screenshots/O01.png"}}], "artifacts": {')
        self.assert_fails("duplicate JSON key: path")

    def test_invalid_artifact_paths_rejected(self) -> None:
        for path in ("/screenshots/O01.png", "C:/screenshots/O01.png", "../screenshots/O01.png",
                     "screenshots/../O01.png", "screenshots\\O01.png", "screenshots//O01.png",
                     "screenshots/./O01.png", "screenshots/a..b.png"):
            with self.subTest(path=path):
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    case.tamper_manifest('"screenshots/O01.png":', json.dumps(path) + ":")
                    case.assert_fails("invalid artifact entry")
                finally:
                    case.doCleanups()

    def test_valid_sealed_record(self) -> None:
        self.record()
        self.assertEqual(evaluate(self.repo, self.sha, "pre-merge")["status"], "PASS")

    def test_relative_symlink_artifact_rejected(self) -> None:
        self.assert_symlink_artifact_rejected("../../../base.txt")

    def test_absolute_symlink_artifact_rejected(self) -> None:
        self.assert_symlink_artifact_rejected("/etc/hosts")

    def assert_symlink_artifact_rejected(self, target: str) -> None:
        directory = self.record(commit=False)
        artifact = directory / "screenshots/O01.png"
        artifact.unlink()
        artifact.symlink_to(target)
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"]["screenshots/O01.png"] = hashlib.sha256(target.encode()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        self.commit("symlink artifact")
        self.assert_fails("non-regular evidence entry")

    def test_gitlink_artifact_rejected(self) -> None:
        directory = self.record(commit=False)
        artifact = directory / "screenshots/O01.png"
        artifact.unlink()
        self.git("add", "-A")
        path = artifact.relative_to(self.repo).as_posix()
        self.git("update-index", "--add", "--cacheinfo", f"160000,{self.sha},{path}")
        self.git("commit", "-qm", "gitlink artifact")
        self.git("reset", "--hard", "HEAD")
        self.assert_fails("non-regular evidence entry")

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
        observed = {
            "vercel_git_commit_sha": "0" * 40,
            "railway_git_commit_sha": self.sha,
            "railway_deployment_id": "deployment-1",
        }
        self.record(tier="test-env", observed=observed)
        with self.assertRaisesRegex(EvidenceError, "observed commit mismatch"):
            evaluate_deploy(self.repo, self.sha, "test-env")
        observed["vercel_git_commit_sha"] = self.sha
        self.record("matching", tier="test-env", observed=observed, completed="2026-09-28T13:00:00Z")
        with self.assertRaisesRegex(EvidenceError, "awaits authenticated source and schema verification"):
            evaluate_deploy(self.repo, self.sha, "test-env")


if __name__ == "__main__":
    unittest.main()
