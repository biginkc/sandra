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
        deployment_id = "dep-a" if "dep-a" in query else "dep-b"
        self._send({"columns": ["id", "status", "deployment_id"], "rows": [[f"inv-{deployment_id}", "running", deployment_id]]})

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
                self.assertEqual(len(report["restate"]), 2)
                self.assertEqual([item["invocations"][0][0] for item in report["restate"]], ["inv-dep-a", "inv-dep-b"])
                sql = captured_sql.read_text().upper()
                self.assertIn("BEGIN TRANSACTION READ ONLY", sql)
                self.assertIn("INBOX_REPLY_SEND.ATTEMPTS", sql)
                self.assertIn("INBOX_OPERATIONS.OPERATIONS", sql)
                for state in ("APPROVED", "CLAIMED", "DISPATCH_STARTED", "PROVIDER_ACCEPTED", "UNCERTAIN"):
                    self.assertIn(state, sql)
                self.assertNotRegex(sql, r"\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b")
                self.assertEqual([call[:2] for call in RestateHandler.calls], [("GET", "/deployments"), ("POST", "/query"), ("POST", "/query")])
                queries = [call[2]["query"] for call in RestateHandler.calls if call[0] == "POST"]
                self.assertTrue(all("status <> 'completed'" in query and f"deployment_id = '{deployment_id}'" in query for query, deployment_id in zip(queries, ("dep-a", "dep-b"))))
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


if __name__ == "__main__":
    unittest.main()
