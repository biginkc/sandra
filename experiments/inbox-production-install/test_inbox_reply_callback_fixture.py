from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
PACKET = HERE / "inbox-reply-callback-fixture.sql"
LOCAL_ENV_PATH = ROOT / "experiments/inbox-reply-send/local-env.py"
OWNED_CLEANUP_PATH = ROOT / "experiments/inbox-reply-send-worker/owned_cleanup.py"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def postgres_bin() -> Path | None:
    candidate = Path(os.environ.get("PG17_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
    if all((candidate / name).exists() for name in ("postgres", "initdb", "pg_ctl", "psql")):
        version = subprocess.run([candidate / "postgres", "--version"], capture_output=True, text=True, check=True).stdout
        if "PostgreSQL) 17." in version:
            return candidate
    return None


@unittest.skipUnless(postgres_bin() is not None, "PostgreSQL 17 local binaries are required")
class ReplyCallbackFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.local_env = load_module(LOCAL_ENV_PATH, "sandra_reply_runtime_local_env")
        if cls.local_env.load_state(False) is not None:
            raise unittest.SkipTest("the owned local-env state already exists; clean it before rerunning")
        cls.local_env.up()
        cls.state = cls.local_env.load_state()
        assert cls.state is not None
        cls.cleanup = load_module(OWNED_CLEANUP_PATH, "sandra_reply_owned_cleanup")
        # The normal worker proof drops these schemas after its run.  This
        # fixture keeps the migrated schemas in place, so the proof standard
        # must include them in the database-wide baseline and residue scan.
        # Keep the dynamic query syntactically valid while excluding no real
        # schema; the sentinel cannot exist in this disposable database.
        cls.cleanup.EPHEMERAL_SCHEMAS = {"__no_ephemeral_schema__"}
        cls.cleanup._COLUMN_CACHE.clear()
        cls.cleanup._PK_CACHE.clear()
        cls.receipt_dir = Path(tempfile.mkdtemp(prefix="sandra-callback-receipt-"))
        cls.receipt_dir.chmod(0o700)

    @classmethod
    def tearDownClass(cls):
        receipt_dir = getattr(cls, "receipt_dir", None)
        if receipt_dir is not None:
            shutil.rmtree(receipt_dir, ignore_errors=True)
        if hasattr(cls, "local_env"):
            cls.local_env.down()

    def _sql(self, statement: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
        bindir = postgres_bin()
        assert bindir is not None
        result = subprocess.run(
            [bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-h", str(self.state["socket"]),
             "-p", str(self.state["port"]), "-U", "postgres", "-d", "postgres"],
            input="SET extra_float_digits=3;\n" + statement,
            text=True,
            capture_output=True,
            check=False,
            timeout=120,
        )
        if check and result.returncode:
            self.fail(result.stderr)
        return result

    def _receipt(self, marker: str) -> Path:
        values = {
            "marker": marker,
            "org_id": str(uuid.uuid4()),
            "requester_id": str(uuid.uuid4()),
            "preparation_id": str(uuid.uuid4()),
            "operation_id": str(uuid.uuid4()),
            "idempotency_key": str(uuid.uuid4()),
            "item_a": str(uuid.uuid4()),
            "item_b": str(uuid.uuid4()),
            "attempt_a": str(uuid.uuid4()),
            "attempt_b": str(uuid.uuid4()),
            "contact_a": str(uuid.uuid4()),
            "contact_b": str(uuid.uuid4()),
            "reference_a": f"sandra-r1-callback-a-{marker.rsplit('-', 1)[-1]}",
            "reference_b": f"sandra-r1-callback-b-{marker.rsplit('-', 1)[-1]}",
        }
        path = self.receipt_dir / f"{marker}.json"
        path.write_text(json.dumps(values, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        path.chmod(0o600)
        return path

    def _packet(self, receipt: Path, *, create: bool, packet: Path = PACKET, check: bool = True) -> subprocess.CompletedProcess[str]:
        values = json.loads(receipt.read_text(encoding="utf-8"))
        args = [
            str(postgres_bin() / "psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", str(packet),
            "-h", str(self.state["socket"]), "-p", str(self.state["port"]), "-U", "postgres", "-d", "postgres",
            "-v", f"fixture_create={'true' if create else 'false'}", "-v", f"fixture_action={'create' if create else 'remove'}",
            "-v", f"fixture_marker={values['marker']}",
        ]
        for name, value in values.items():
            if name == "marker":
                continue
            args.extend(("-v", f"fixture_{name}={value}"))
        result = subprocess.run(args, text=True, capture_output=True, check=False, timeout=120)
        if check and result.returncode:
            self.fail(result.stderr)
        return result

    def _callback(self, reference: str, marker: str) -> dict[str, object]:
        payload = json.dumps({"__sandra_fixture_marker": marker, "fixture": "r1_callback_gate"})
        result = self._sql(
            "SET LOCAL ROLE service_role; "
            f"SELECT public.inbox_reply_reconcile_callback('sendillo','{reference}','delivered','{payload}'::jsonb)::text;"
            "RESET ROLE;"
        )
        return json.loads(result.stdout.strip())

    def _sweep(self) -> dict[str, object]:
        result = self._sql("SET LOCAL ROLE service_role; SELECT public.inbox_reply_sweep_unmatched_callbacks(100)::text; RESET ROLE;")
        return json.loads(result.stdout.strip())

    def test_real_schema_callbacks_sweep_idempotency_and_whole_database_cleanup(self):
        marker = "sandra-inbox-r1-callback-gate-real"
        receipt = self._receipt(marker)
        values = json.loads(receipt.read_text(encoding="utf-8"))
        org = values["org_id"]
        try:
            org_tables, user_tables, all_tables = self.cleanup.discover(self._sql_text)
            baseline = self.cleanup.snapshot_baseline(self._sql_text, all_tables)
            self.assertTrue(all_tables, "whole-database discovery found no base tables")
            self.assertNotIn("CREATE SCHEMA", PACKET.read_text(encoding="utf-8"))
            self.assertNotIn("CREATE TABLE", PACKET.read_text(encoding="utf-8"))

            self._packet(receipt, create=True)
            self.assertEqual(self._sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE org_id='{org}' AND state='provider_accepted';").stdout.strip(), "2")
            self.assertEqual(self._sql(f"SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider_reference='{values['reference_b']}' AND payload->>'__sandra_fixture_marker'='{marker}';").stdout.strip(), "1")
            self.assertEqual(self._sql("SELECT to_regclass('inbox_reply_send.r1_callback_gate_fixtures') IS NULL;").stdout.strip(), "t")

            callback_a = self._callback(values["reference_a"], marker)
            self.assertEqual(callback_a["kind"], "reconciled")
            self.assertEqual(self._sql(f"SELECT state FROM inbox_reply_send.attempts WHERE id='{values['attempt_a']}';").stdout.strip(), "delivered")

            sweep_b = self._sweep()
            self.assertEqual(sweep_b["drained"], 1)
            self.assertEqual(self._sql(f"SELECT state FROM inbox_reply_send.attempts WHERE id='{values['attempt_b']}';").stdout.strip(), "delivered")
            self.assertEqual(self._sql(f"SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider_reference='{values['reference_b']}';").stdout.strip(), "0")

            before_second = self._sql(
                f"SELECT id::text,state,receipt_version FROM inbox_reply_send.attempts WHERE id IN ('{values['attempt_a']}','{values['attempt_b']}') ORDER BY id;"
            ).stdout
            second_callback = self._callback(values["reference_a"], marker)
            second_sweep = self._sweep()
            self.assertEqual(second_callback["kind"], "already_processed")
            self.assertEqual(second_sweep["drained"], 0)
            self.assertEqual(before_second, self._sql(
                f"SELECT id::text,state,receipt_version FROM inbox_reply_send.attempts WHERE id IN ('{values['attempt_a']}','{values['attempt_b']}') ORDER BY id;"
            ).stdout)

            self._packet(receipt, create=False)
            self.cleanup.assert_clean(self._sql_text, all_tables, baseline, [org], [])
            for query in (
                f"SELECT count(*) FROM inbox_reply_send.attempts WHERE id IN ('{values['attempt_a']}','{values['attempt_b']}');",
                f"SELECT count(*) FROM inbox_reply_send.callback_receipts WHERE external_id IN ('{values['reference_a']}','{values['reference_b']}');",
                f"SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider_reference IN ('{values['reference_a']}','{values['reference_b']}');",
                f"SELECT count(*) FROM inbox_reply_send.operations WHERE id='{values['operation_id']}';",
                f"SELECT count(*) FROM inbox_reply_review.preparations WHERE id='{values['preparation_id']}';",
            ):
                self.assertEqual(self._sql(query).stdout.strip(), "0")
            self.assertEqual(receipt.stat().st_mode & 0o777, 0o600)
            receipt.unlink()
            self.assertFalse(receipt.exists(), "receipt removal is part of the zero-residue proof")
        finally:
            if receipt.exists():
                # The assertion above is deliberately allowed to fail, but a
                # failed test must not strand a receipt or DB fixture for the
                # next run. The DB packet is retried only when the exact
                # receipt is known and the rows are present.
                if self._sql(f"SELECT to_regclass('inbox_reply_send.attempts') IS NOT NULL;").stdout.strip() == "t":
                    self._packet(receipt, create=False, check=False)
                receipt.unlink(missing_ok=True)

    def _sql_text(self, statement: str, check: bool = True) -> str:
        result = self._sql(statement, check=check)
        return result.stdout.strip()


if __name__ == "__main__":
    unittest.main()
