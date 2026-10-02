from __future__ import annotations

import json
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "electric-slot-provenance.py"
PROJECT_REF = "ncsngxlcyxylaeskiteu"
STREAM = f"inbox_{PROJECT_REF}"
EXPECTED_SLOT = f"electric_slot_{STREAM}"


def postgres_bin() -> Path | None:
    candidates: list[Path] = []
    if os.environ.get("PG17_BIN"):
        candidates.append(Path(os.environ["PG17_BIN"]))
    for command in ("postgres", "initdb", "pg_ctl", "psql"):
        found = shutil.which(command)
        if found:
            candidates.append(Path(found).parent)
            break
    candidates.extend((Path("/opt/homebrew/opt/postgresql@17/bin"), Path("/usr/local/opt/postgresql@17/bin")))
    for candidate in candidates:
        if all((candidate / name).exists() for name in ("postgres", "initdb", "pg_ctl", "psql")):
            version = subprocess.run([candidate / "postgres", "--version"], capture_output=True, text=True, check=True).stdout
            if "PostgreSQL) 17." in version:
                return candidate
    return None


@unittest.skipUnless(postgres_bin() is not None, "PostgreSQL 17 local binaries are required")
class ElectricSlotProvenanceTests(unittest.TestCase):
    def test_before_after_cleanup_receipt_proves_one_slot_and_targets_only_it(self):
        bindir = postgres_bin()
        assert bindir is not None
        with tempfile.TemporaryDirectory(prefix="sandra-slot-pg17-") as temp:
            root = Path(temp)
            data = root / "data"
            socket = Path("/tmp") / f"sandra-slot-{os.getpid()}"
            if socket.exists():
                shutil.rmtree(socket)
            socket.mkdir()
            receipt = root / "slot-receipt.json"
            subprocess.run([bindir / "initdb", "-D", data, "-A", "trust", "-U", "postgres", "--no-locale"], check=True, capture_output=True, text=True)
            subprocess.run([bindir / "pg_ctl", "-D", data, "-l", root / "postgres.log", "-o", f"-k {socket} -c listen_addresses='' -c wal_level=logical", "-w", "start"], check=True, capture_output=True, text=True)
            env = {**os.environ, "PGHOST": str(socket), "PGUSER": "postgres", "PGDATABASE": "postgres", "INBOX_SLOT_PSQL_BIN": str(bindir / "psql")}
            try:
                self._run(env, "before", receipt)
                before = json.loads(receipt.read_text())
                self.assertEqual(before["phase"], "before")
                self._psql(bindir, env, f"SELECT pg_create_logical_replication_slot('{EXPECTED_SLOT}', 'pgoutput');")
                self._run(env, "after", receipt)
                after = json.loads(receipt.read_text())
                self.assertEqual(after["phase"], "after")
                self.assertEqual(after["new_slot"]["slot_name"], EXPECTED_SLOT)
                self.assertEqual(after["new_slot"]["plugin"], "pgoutput")
                self._run(env, "cleanup", receipt)
                cleaned = json.loads(receipt.read_text())
                self.assertEqual(cleaned["phase"], "cleaned")
                self.assertEqual(self._psql(bindir, env, f"SELECT count(*) FROM pg_replication_slots WHERE slot_name='{EXPECTED_SLOT}';").stdout.strip(), "0")
            finally:
                subprocess.run([bindir / "pg_ctl", "-D", data, "-w", "stop"], check=True, capture_output=True, text=True)
                shutil.rmtree(socket, ignore_errors=True)

    def test_after_rejects_a_second_new_slot_and_cleanup_cannot_be_redirected(self):
        bindir = postgres_bin()
        assert bindir is not None
        with tempfile.TemporaryDirectory(prefix="sandra-slot-mutation-pg17-") as temp:
            root = Path(temp)
            data = root / "data"
            socket = Path("/tmp") / f"sandra-slot-mutation-{os.getpid()}"
            if socket.exists():
                shutil.rmtree(socket)
            socket.mkdir()
            receipt = root / "slot-receipt.json"
            extra = EXPECTED_SLOT + "_extra"
            subprocess.run([bindir / "initdb", "-D", data, "-A", "trust", "-U", "postgres", "--no-locale"], check=True, capture_output=True, text=True)
            subprocess.run([bindir / "pg_ctl", "-D", data, "-l", root / "postgres.log", "-o", f"-k {socket} -c listen_addresses='' -c wal_level=logical", "-w", "start"], check=True, capture_output=True, text=True)
            env = {**os.environ, "PGHOST": str(socket), "PGUSER": "postgres", "PGDATABASE": "postgres", "INBOX_SLOT_PSQL_BIN": str(bindir / "psql")}
            try:
                self._run(env, "before", receipt)
                self._psql(bindir, env, f"SELECT pg_create_logical_replication_slot('{EXPECTED_SLOT}', 'pgoutput'); SELECT pg_create_logical_replication_slot('{extra}', 'pgoutput');")
                rejected = self._run(env, "after", receipt, check=False)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("exactly one", rejected.stderr)
                original = json.loads(receipt.read_text())
                original["phase"] = "after"
                original["expected_slot_name"] = extra
                original["new_slot"] = {"slot_name": EXPECTED_SLOT, "plugin": "pgoutput", "database": "postgres", "active": False}
                receipt.write_text(json.dumps(original))
                redirected = self._run(env, "cleanup", receipt, check=False)
                self.assertNotEqual(redirected.returncode, 0)
                self.assertIn("receipt contract", redirected.stderr)
                self.assertEqual(self._psql(bindir, env, f"SELECT count(*) FROM pg_replication_slots WHERE slot_name IN ('{EXPECTED_SLOT}','{extra}');").stdout.strip(), "2")
            finally:
                subprocess.run([bindir / "pg_ctl", "-D", data, "-w", "stop"], check=True, capture_output=True, text=True)
                shutil.rmtree(socket, ignore_errors=True)

    def _run(self, env: dict[str, str], phase: str, receipt: Path, check: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(["python3", str(SCRIPT), phase, "--project-ref", PROJECT_REF, "--stream-id", STREAM, "--receipt", str(receipt), "--local-disposable"], env=env, capture_output=True, text=True)
        if check and result.returncode != 0:
            self.fail(result.stderr)
        return result

    def _psql(self, bindir: Path, env: dict[str, str], sql: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run([bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], env=env, capture_output=True, text=True)
        if result.returncode != 0:
            self.fail(result.stderr)
        return result


if __name__ == "__main__":
    unittest.main()
