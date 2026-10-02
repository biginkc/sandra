from __future__ import annotations

import json
from pathlib import Path
import http.server
import os
import shutil
import subprocess
import tempfile
import threading
import unittest


HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "recovery-inventory.py"
PROJECT_REF = "ncsngxlcyxylaeskiteu"
DB_RESULT = {"reply_attempts": [{"state": "uncertain", "id": "attempt-1"}], "metadata_operations": [{"id": "operation-1", "steps": []}]}


class RestateHandler(http.server.BaseHTTPRequestHandler):
    calls: list[tuple[str, str, dict | None]] = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.__class__.calls.append((self.command, self.path, None))
        if self.path == "/deployments":
            body = {"deployments": [
                {"id": "dep-a", "uri": "http://operation-a", "services": [{"name": "InboxMetadataOperation"}]},
                {"id": "dep-b", "uri": "http://reply-b", "services": [{"name": "InboxReplySend"}]},
            ]}
            self._send(body)
            return
        self.send_error(404)

    def do_POST(self):
        length = int(self.headers["content-length"])
        payload = json.loads(self.rfile.read(length))
        self.__class__.calls.append((self.command, self.path, payload))
        if self.path != "/query":
            self.send_error(405)
            return
        query = payload.get("query", "")
        if "pinned_deployment_id IS NULL" in query:
            self._send({"columns": ["id", "status", "target_service_name", "target_handler_name", "target_service_key", "pinned_deployment_id"], "rows": [["inv-pending", "running", "InboxReplySend", "send", "key-pending", None]]})
            return
        deployment_id = "dep-a" if "dep-a" in query else "dep-b"
        self._send({"columns": ["id", "status", "target_service_name", "target_handler_name", "target_service_key", "pinned_deployment_id"], "rows": [[f"inv-{deployment_id}", "running", "InboxReplySend", "send", "key", deployment_id]]})

    def _send(self, body: object):
        encoded = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


class RecoveryInventoryTests(unittest.TestCase):
    def test_inventory_reads_db_and_every_registered_deployment_without_mutation(self):
        with tempfile.TemporaryDirectory(prefix="sandra-recovery-inventory-") as temp:
            root = Path(temp)
            fake_psql = root / "fake-psql.py"
            captured_sql = root / "query.sql"
            fake_psql.write_text(
                "#!/usr/bin/env python3\n"
                "import json, pathlib, sys\n"
                f"pathlib.Path({str(captured_sql)!r}).write_text(sys.argv[sys.argv.index('-c') + 1])\n"
                f"print(json.dumps({DB_RESULT!r}))\n"
            )
            fake_psql.chmod(0o700)
            RestateHandler.calls = []
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RestateHandler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = subprocess.run(
                    ["python3", str(SCRIPT), "--project-ref", PROJECT_REF, "--restate-admin-url", f"http://127.0.0.1:{server.server_port}", "--local-disposable"],
                    env={**os.environ, "PGHOST": "/tmp/sandra-recovery-test-socket", "PGUSER": "postgres", "PGDATABASE": "postgres", "INBOX_RECOVERY_PSQL_BIN": str(fake_psql)},
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                report = json.loads(result.stdout)
                self.assertTrue(report["read_only"])
                self.assertEqual(len(report["restate"]), 3)
                self.assertEqual([item["invocations"][0]["id"] for item in report["restate"]], ["inv-dep-a", "inv-dep-b", "inv-pending"])
                self.assertTrue(report["restate"][2]["pending_unpinned"])
                sql = captured_sql.read_text().upper()
                self.assertIn("BEGIN TRANSACTION READ ONLY", sql)
                self.assertIn("INBOX_REPLY_SEND.ATTEMPTS", sql)
                self.assertIn("INBOX_OPERATIONS.OPERATIONS", sql)
                for state in ("APPROVED", "CLAIMED", "DISPATCH_STARTED", "PROVIDER_ACCEPTED", "UNCERTAIN"):
                    self.assertIn(state, sql)
                self.assertNotRegex(sql, r"\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b")
                self.assertEqual([call[:2] for call in RestateHandler.calls], [("GET", "/deployments"), ("POST", "/query"), ("POST", "/query"), ("POST", "/query")])
                queries = [call[2]["query"] for call in RestateHandler.calls if call[0] == "POST"]
                self.assertTrue(all("status <> 'completed'" in query and "target_service_name" in query and "target_handler_name" in query and "target_service_key" in query and "pinned_deployment_id" in query for query in queries))
                self.assertIn("pinned_deployment_id = 'dep-a'", queries[0])
                self.assertIn("pinned_deployment_id = 'dep-b'", queries[1])
                self.assertIn("pinned_deployment_id IS NULL", queries[2])
            finally:
                server.shutdown()
                thread.join(timeout=5)
                server.server_close()

    def test_restate_admin_url_rejects_credentials_before_any_request(self):
        result = subprocess.run(
            ["python3", str(SCRIPT), "--project-ref", PROJECT_REF, "--restate-admin-url", "http://user:secret@127.0.0.1:9070", "--local-disposable"],
            env={**os.environ, "PGHOST": "/tmp/sandra-recovery-test-socket", "PGUSER": "postgres", "PGDATABASE": "postgres", "INBOX_RECOVERY_PSQL_BIN": "/definitely/missing/psql"},
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("credentials", result.stderr)
        self.assertNotIn("secret", result.stderr)

    def test_host_ref_ca_and_libpq_override_inputs_fail_before_database_read(self):
        base = {
            **os.environ,
            "PGHOST": f"db.{PROJECT_REF}.supabase.co",
            "PGSSLMODE": "verify-full",
            "PGSSLROOTCERT": str(HERE / "supabase-prod-ca-2021.crt"),
            "INBOX_RECOVERY_PSQL_BIN": "/definitely/missing/psql",
        }
        command = ["python3", str(SCRIPT), "--project-ref", PROJECT_REF, "--restate-admin-url", "http://127.0.0.1:9070", "--write", str(Path(tempfile.gettempdir()) / "recovery-no-write.json")]
        wrong_host = subprocess.run(command, env={**base, "PGHOST": "db.example.supabase.co"}, capture_output=True, text=True)
        self.assertEqual(wrong_host.returncode, 3)
        self.assertIn("direct Supabase host", wrong_host.stderr)
        wrong_ref = subprocess.run([*command[:3], "copflsklaefwzipsrjqz", *command[4:]], env=base, capture_output=True, text=True)
        self.assertEqual(wrong_ref.returncode, 3)
        self.assertIn("selected direct", wrong_ref.stderr)
        wrong_ca = subprocess.run(command, env={**base, "PGSSLROOTCERT": str(SCRIPT)}, capture_output=True, text=True)
        self.assertEqual(wrong_ca.returncode, 3)
        self.assertIn("pinned Supabase CA", wrong_ca.stderr)
        for name in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
            rejected = subprocess.run(command, env={**base, name: "attacker-controlled"}, capture_output=True, text=True)
            self.assertEqual(rejected.returncode, 3)
            self.assertIn(name, rejected.stderr)


if __name__ == "__main__":
    unittest.main()
