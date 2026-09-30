from pathlib import Path
import base64
import hashlib
import hmac
import os
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
INSTALL = HERE / "electric-replication-role.production.sql"
TEARDOWN = HERE / "electric-replication-role.production-teardown.sql"
RUNNER = HERE / "run-electric-replication-role.py"
PINNED_CA = HERE / "supabase-prod-ca-2021.crt"
PROJECT_REF = "ncsngxlcyxylaeskiteu"


def verifier(password: str = "dummy-electric-password") -> str:
    salt = b"sandra-electric1"
    iterations = 4096
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()
    encode = lambda value: base64.b64encode(value).decode().rstrip("=")
    return f"SCRAM-SHA-256${iterations}:{encode(salt)}${encode(stored_key)}:{encode(server_key)}"


def postgres_bin() -> Path | None:
    candidates = []
    if os.environ.get("PG17_BIN"):
        candidates.append(Path(os.environ["PG17_BIN"]))
    for command in ("postgres", "initdb", "pg_ctl", "psql"):
        found = shutil.which(command)
        if found:
            candidates.append(Path(found).parent)
            break
    candidates.extend((Path("/opt/homebrew/opt/postgresql@17/bin"), Path("/usr/local/opt/postgresql@17/bin")))
    for candidate in candidates:
        if (candidate / "postgres").exists() and (candidate / "initdb").exists() and (candidate / "pg_ctl").exists() and (candidate / "psql").exists():
            version = subprocess.run([candidate / "postgres", "--version"], capture_output=True, text=True, check=True).stdout
            if "PostgreSQL) 17." in version:
                return candidate
    return None


class ProductionElectricPacketTests(unittest.TestCase):
    def test_install_is_project_ref_guarded_and_records_prior_identity(self):
        source = INSTALL.read_text()
        self.assertIn("ncsngxlcyxylaeskiteu", source)
        self.assertIn("copflsklaefwzipsrjqz", source)
        self.assertIn("supplied_ref NOT IN", source)
        self.assertIn("prior_replica_identity", source)
        self.assertIn("prior_replica_identity_index", source)
        self.assertIn("current_setting('sandra.inbox_project_ref')", source)
        self.assertIn("current_setting('sandra.inbox_connection_project_ref')", source)
        self.assertIn("well-formed SCRAM-SHA-256 verifier", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL", source)
        self.assertIn("CREATE PUBLICATION electric_publication_inbox", source)
        self.assertNotIn("install_fixture", source)

    def test_install_requires_a_scram_verifier_and_connected_ref(self):
        source = INSTALL.read_text()
        self.assertIn("connection_project_ref is required", source)
        self.assertIn("electric_password is required", source)
        self.assertIn("SCRAM-SHA-256", source)
        self.assertNotIn("PASSWORD :'electric_password'", source)
        self.assertNotIn("DECLARE supplied_ref text := :'project_ref'", source)
        self.assertNotIn("sandra-inbox-http-owned-synthetic-20260917", source)

    def test_teardown_requires_receipt_and_restores_identity_without_dropping_role(self):
        source = TEARDOWN.read_text()
        self.assertIn("prior_replica_identity is required", source)
        self.assertIn("DROP PUBLICATION electric_publication_inbox", source)
        self.assertIn("ALTER ROLE inbox_electric_replication NOLOGIN", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY DEFAULT;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY NOTHING;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY USING INDEX", source)
        self.assertNotIn("DROP ROLE inbox_electric_replication", source)
        self.assertNotIn("install_fixture", source)

    def test_both_packets_execute_on_postgres17_and_restore_recorded_identity(self):
        bindir = postgres_bin()
        if bindir is None:
            if os.environ.get("CI", "").lower() == "true":
                self.fail("PostgreSQL 17 local binaries are required in CI; refusing a silent skip")
            self.skipTest("PostgreSQL 17 local binaries are required")
        with tempfile.TemporaryDirectory(prefix="sandra-electric-pg17-") as temp:
            root = Path(temp)
            data = root / "data"
            socket = root / "socket"
            socket.mkdir()
            subprocess.run([bindir / "initdb", "-D", data, "-A", "trust", "-U", "postgres", "--no-locale"], check=True, capture_output=True, text=True)
            log = root / "postgres.log"
            subprocess.run([bindir / "pg_ctl", "-D", data, "-l", log, "-o", f"-k {socket} -c listen_addresses=''", "-w", "start"], check=True, capture_output=True, text=True)
            env = {**os.environ, "PGHOST": str(socket), "PGUSER": "postgres", "PGDATABASE": "postgres"}
            try:
                self._psql(bindir, env, "CREATE SCHEMA inbox_bridge; CREATE TABLE inbox_bridge.summaries (id bigint NOT NULL, body text); CREATE UNIQUE INDEX summaries_replica_identity_idx ON inbox_bridge.summaries (id); ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY USING INDEX summaries_replica_identity_idx;")
                scram = verifier()
                mismatch = self._psql(bindir, env, self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": "copflsklaefwzipsrjqz", "electric_password": scram}))
                self.assertNotEqual(mismatch.returncode, 0)
                self.assertIn("does not match the connected database", mismatch.stderr)
                self.assertNotIn(scram, mismatch.stdout + mismatch.stderr)
                plaintext = self._psql(bindir, env, self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "electric_password": "not-a-verifier"}))
                self.assertNotEqual(plaintext.returncode, 0)
                self.assertIn("well-formed SCRAM-SHA-256 verifier", plaintext.stderr)
                self.assertNotIn("not-a-verifier", plaintext.stdout + plaintext.stderr)
                install = self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "electric_password": scram})
                result = self._psql(bindir, env, install, expect_success=True)
                self.assertNotIn(scram, result.stdout + result.stderr)
                self.assertEqual(self._psql(bindir, env, "SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass;", True).stdout.strip(), "f")
                self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM pg_publication_tables WHERE pubname='electric_publication_inbox' AND schemaname='inbox_bridge' AND tablename='summaries';", True).stdout.strip(), "1")
                teardown = self._packet_input(TEARDOWN, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "prior_replica_identity": "i", "prior_replica_identity_index": "summaries_replica_identity_idx"})
                self._psql(bindir, env, teardown, expect_success=True)
                restored = self._psql(bindir, env, "SELECT c.relreplident::text || ':' || coalesce((SELECT c2.relname FROM pg_index i JOIN pg_class c2 ON c2.oid=i.indexrelid WHERE i.indrelid=c.oid AND i.indisreplident), '') FROM pg_class c WHERE c.oid='inbox_bridge.summaries'::regclass;", True).stdout.strip()
                self.assertEqual(restored, "i:summaries_replica_identity_idx")
                self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM pg_publication WHERE pubname='electric_publication_inbox';", True).stdout.strip(), "0")
                self.assertEqual(self._psql(bindir, env, "SELECT rolcanlogin FROM pg_roles WHERE rolname='inbox_electric_replication';", True).stdout.strip(), "f")
            finally:
                subprocess.run([bindir / "pg_ctl", "-D", data, "-w", "stop"], check=True, capture_output=True, text=True)

    def test_plaintext_is_refused_and_verifier_is_not_in_child_args_or_output(self):
        with tempfile.TemporaryDirectory(prefix="sandra-electric-runner-") as temp:
            root = Path(temp)
            args_file = root / "args.txt"
            fake_psql = root / "fake-psql.py"
            fake_psql.write_text("#!/usr/bin/env python3\nimport os, sys\nPath = __import__('pathlib').Path\nPath(os.environ['ARGS_FILE']).write_text(' '.join(sys.argv[1:]))\nsys.stdin.buffer.read()\nprint('fake psql ok')\n")
            fake_psql.chmod(0o700)
            env = {**os.environ, "PGHOST": f"db.{PROJECT_REF}.supabase.co", "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(PINNED_CA), "INBOX_ELECTRIC_PSQL_BIN": str(fake_psql), "ARGS_FILE": str(args_file)}
            rejected = subprocess.run(["python3", str(RUNNER), "--packet", "install", "--project-ref", PROJECT_REF], input="plain-text-password\n", text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertNotIn("plain-text-password", rejected.stdout + rejected.stderr)
            scram = verifier()
            accepted = subprocess.run(["python3", str(RUNNER), "--packet", "install", "--project-ref", PROJECT_REF], input=scram + "\n", text=True, capture_output=True, env=env, check=False)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertNotIn(scram, accepted.stdout + accepted.stderr)
            self.assertNotIn(scram, args_file.read_text())
            mismatch = subprocess.run(["python3", str(RUNNER), "--packet", "install", "--project-ref", "copflsklaefwzipsrjqz"], input=scram + "\n", text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("does not match PGHOST", mismatch.stderr)
            self.assertNotIn(scram, mismatch.stdout + mismatch.stderr)

    def test_host_routing_and_tls_overrides_are_refused(self):
        base = {**os.environ, "PGHOST": f"db.{PROJECT_REF}.supabase.co", "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(PINNED_CA), "INBOX_ELECTRIC_PSQL_BIN": "/definitely/missing/psql"}
        for name in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
            env = {**base, name: "attacker-controlled"}
            rejected = subprocess.run(["python3", str(RUNNER), "--packet", "teardown", "--project-ref", PROJECT_REF, "--prior-replica-identity", "d"], text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn(name, rejected.stderr)
        for key, value in (("PGSSLMODE", "require"), ("PGSSLROOTCERT", str(HERE / "electric-replication-role.production.sql"))):
            env = {**base, key: value}
            rejected = subprocess.run(["python3", str(RUNNER), "--packet", "teardown", "--project-ref", PROJECT_REF, "--prior-replica-identity", "d"], text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("pinned Supabase CA" if key == "PGSSLROOTCERT" else "verify-full", rejected.stderr)

    @staticmethod
    def _packet_input(packet: Path, values: dict[str, str]) -> str:
        lines = [f"\\set {key} '{value}'" for key, value in values.items()]
        return "\n".join(lines + [f"\\i '{packet}'", ""])

    @staticmethod
    def _psql(bindir: Path, env: dict[str, str], input_sql: str, expect_success: bool = False):
        result = subprocess.run([bindir / "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-"], input=input_sql, text=True, capture_output=True, env=env, check=False)
        if expect_success:
            if result.returncode:
                raise AssertionError(result.stderr)
        return result


if __name__ == "__main__":
    unittest.main()
