from contextlib import contextmanager
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
INSTALL = HERE / "electric-replication-role.production.sql"
TEARDOWN = HERE / "electric-replication-role.production-teardown.sql"
RUNNER = HERE / "run-electric-replication-role.py"
PINNED_CA = HERE / "supabase-prod-ca-2021.crt"
PROJECT_REF = "ncsngxlcyxylaeskiteu"
ELECTRIC_STREAM_ID = f"inbox_{PROJECT_REF}"
REPLICATION_SLOT = f"electric_slot_{ELECTRIC_STREAM_ID}"
ELECTRIC_PUBLICATION = f"electric_publication_{ELECTRIC_STREAM_ID}"
OTHER_ELECTRIC_SLOT = f"electric_slot_{ELECTRIC_STREAM_ID}_other"
LEGACY_ELECTRIC_SLOT = "electric_slot_inbox"
TEMPORARY_ELECTRIC_SLOT = "electric_slot_" + ("0123456789abcdef" * 2)
EXECUTOR_ROLE = "inbox_packet_executor"
NON_OWNER_ROLE = "inbox_teardown_non_owner"
NO_REPLICATION_ROLE = "inbox_install_no_replication"
OTHER_DATABASE = "inbox_other_database"


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
        if all((candidate / name).exists() for name in ("postgres", "initdb", "pg_ctl", "psql", "pg_recvlogical")):
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
        self.assertIn("CREATE PUBLICATION %I", source)
        self.assertIn("Electric publication created as %", source)
        self.assertIn("contract_publication_name", source)
        self.assertNotIn("install_fixture", source)

    def test_install_requires_a_scram_verifier_and_connected_ref(self):
        source = INSTALL.read_text()
        self.assertIn("connection_project_ref is required", source)
        self.assertIn("electric_password is required", source)
        self.assertIn("SCRAM-SHA-256", source)
        self.assertNotIn("PASSWORD :'electric_password'", source)
        self.assertNotIn("DECLARE supplied_ref text := :'project_ref'", source)
        self.assertNotIn("sandra-inbox-http-owned-synthetic-20260917", source)

    def test_teardown_requires_receipt_and_drops_role_idempotently(self):
        source = TEARDOWN.read_text()
        self.assertIn("prior_replica_identity is required", source)
        self.assertIn("DROP PUBLICATION %I", source)
        self.assertIn("DROP ROLE inbox_electric_replication", source)
        self.assertIn("pg_drop_replication_slot", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY DEFAULT;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY NOTHING;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY USING INDEX", source)
        self.assertIn("replication_slot_already_absent", source)
        self.assertIn("publication_already_absent", source)
        self.assertIn("role_already_absent", source)
        self.assertIn("must equal derived Electric slot name", source)
        self.assertIn("slot_type", source)
        self.assertIn("pgoutput", source)
        self.assertIn("other logical slot(s)", source)
        self.assertIn(r"slot_name LIKE 'electric\_slot\_%' ESCAPE '\'", source)
        self.assertNotIn("electric_slot_prefix", source)
        self.assertIn("replication_slot_action", source)
        self.assertLess(source.index("COMMIT;"), source.index("pg_drop_replication_slot"))
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
            subprocess.run([bindir / "pg_ctl", "-D", data, "-l", log, "-o", f"-k {socket} -c listen_addresses='' -c wal_level=logical", "-w", "start"], check=True, capture_output=True, text=True)
            admin_env = {**os.environ, "PGHOST": str(socket), "PGUSER": "postgres", "PGDATABASE": "postgres"}
            env = {**admin_env, "PGUSER": EXECUTOR_ROLE}
            non_owner_env = {**admin_env, "PGUSER": NON_OWNER_ROLE}
            no_replication_env = {**admin_env, "PGUSER": NO_REPLICATION_ROLE}
            other_database_env = {**admin_env, "PGUSER": EXECUTOR_ROLE, "PGDATABASE": OTHER_DATABASE}
            try:
                self._psql(
                    bindir,
                    admin_env,
                    "CREATE ROLE inbox_packet_executor LOGIN CREATEROLE REPLICATION BYPASSRLS;"
                    "CREATE ROLE inbox_teardown_non_owner LOGIN CREATEROLE REPLICATION BYPASSRLS;"
                    "CREATE ROLE inbox_install_no_replication LOGIN CREATEROLE BYPASSRLS;"
                    f"CREATE DATABASE {OTHER_DATABASE};"
                    "GRANT CONNECT ON DATABASE postgres TO inbox_packet_executor WITH GRANT OPTION;"
                    "GRANT CREATE ON DATABASE postgres TO inbox_packet_executor;"
                    "GRANT CONNECT ON DATABASE postgres TO inbox_teardown_non_owner;"
                    "CREATE SCHEMA inbox_bridge;"
                    "CREATE TABLE inbox_bridge.summaries (id bigint NOT NULL, body text);"
                    "CREATE UNIQUE INDEX summaries_replica_identity_idx ON inbox_bridge.summaries (id);"
                    "ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY USING INDEX summaries_replica_identity_idx;"
                    "ALTER TABLE inbox_bridge.summaries ENABLE ROW LEVEL SECURITY;"
                    "ALTER TABLE inbox_bridge.summaries OWNER TO inbox_packet_executor;"
                    "ALTER SCHEMA inbox_bridge OWNER TO inbox_packet_executor;"
                    "GRANT USAGE ON SCHEMA inbox_bridge TO inbox_teardown_non_owner;"
                    f"GRANT CONNECT ON DATABASE {OTHER_DATABASE} TO inbox_packet_executor;"
                    f"GRANT CREATE ON DATABASE {OTHER_DATABASE} TO inbox_packet_executor;"
                    "SET password_encryption = 'scram-sha-256';"
                    "CREATE ROLE scram_verifier_source NOLOGIN PASSWORD 'dummy-electric-password';",
                    expect_success=True,
                )
                scram = self._psql(bindir, admin_env, "SELECT rolpassword FROM pg_authid WHERE rolname = 'scram_verifier_source';", expect_success=True).stdout.strip()
                self.assertRegex(scram, r"^SCRAM-SHA-256\$[1-9][0-9]{0,9}:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$")
                mismatch = self._psql(bindir, env, self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": "copflsklaefwzipsrjqz", "electric_password": scram}))
                self.assertNotEqual(mismatch.returncode, 0)
                self.assertIn("does not match the connected database", mismatch.stderr)
                self.assertNotIn(scram, mismatch.stdout + mismatch.stderr)
                plaintext = self._psql(bindir, env, self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "electric_password": "not-a-verifier"}))
                self.assertNotEqual(plaintext.returncode, 0)
                self.assertIn("well-formed SCRAM-SHA-256 verifier", plaintext.stderr)
                self.assertNotIn("not-a-verifier", plaintext.stdout + plaintext.stderr)

                # Both install-side executor failures must happen before the
                # transaction and leave the table/catalog untouched.
                non_owner_install = self._psql(bindir, non_owner_env, self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "electric_password": scram}), expect_success=False)
                self.assertIn("must own inbox_bridge.summaries", non_owner_install.stderr)
                self._assert_uninstalled_state(bindir, env)
                no_replication_install = self._psql(bindir, no_replication_env, self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "electric_password": scram}), expect_success=False)
                self.assertIn("must have REPLICATION", no_replication_install.stderr)
                self._assert_uninstalled_state(bindir, env)

                install = self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "electric_password": scram})
                result = self._psql(bindir, env, install, expect_success=True)
                self.assertNotIn(scram, result.stdout + result.stderr)
                install_receipt = json.loads(result.stdout)
                self.assertEqual(install_receipt["database"], "postgres")
                self.assertEqual(install_receipt["slot_name"], REPLICATION_SLOT)
                self.assertEqual(install_receipt["plugin"], "pgoutput")
                self.assertEqual(self._psql(bindir, env, "SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass;", True).stdout.strip(), "f")
                self.assertEqual(self._psql(bindir, env, f"SELECT count(*) FROM pg_publication_tables WHERE pubname='{ELECTRIC_PUBLICATION}' AND schemaname='inbox_bridge' AND tablename='summaries';", True).stdout.strip(), "1")

                # A same-named slot in another database is not ours. The
                # preflight must reject it without dropping that slot or the
                # current database's publication/role.
                self._create_slot(bindir, other_database_env)
                wrong_database = self._psql(bindir, env, self._teardown_input(), expect_success=False)
                self.assertIn("belongs to database", wrong_database.stderr)
                self._assert_installed_state(bindir, env, expected_slot_count="0")
                self.assertEqual(self._slot_count(bindir, other_database_env, REPLICATION_SLOT), "1")
                self._drop_slot(bindir, other_database_env, REPLICATION_SLOT)

                # A wrong logical-decoding plugin is not Electric provenance.
                self._create_slot(bindir, env, plugin="test_decoding")
                wrong_plugin = self._psql(bindir, env, self._teardown_input(), expect_success=False)
                self.assertIn("expected pgoutput", wrong_plugin.stderr)
                self._assert_installed_state(bindir, env)
                self._drop_slot(bindir, env, REPLICATION_SLOT)

                # An active slot is never dropped, even when every other
                # provenance field is correct.
                self._create_slot(bindir, env)
                active_receiver = self._start_replication(bindir, env)
                try:
                    active = self._psql(bindir, env, self._teardown_input(), expect_success=False)
                    self.assertIn("is active", active.stderr)
                    self._assert_installed_state(bindir, env)
                finally:
                    active_receiver.terminate()
                    active_receiver.wait(timeout=5)
                    if active_receiver.stdout:
                        active_receiver.stdout.close()
                    if active_receiver.stderr:
                        active_receiver.stderr.close()
                self._drop_slot(bindir, env, REPLICATION_SLOT)

                # A nonexistent operator value is rejected even when the
                # real Electric slot exists; it must not fall through to a
                # successful name-only cleanup.
                self._create_slot(bindir, env)
                nonexistent_values = self._teardown_values()
                nonexistent_values["replication_slot_name"] = REPLICATION_SLOT + "_missing"
                nonexistent = self._psql(bindir, env, self._packet_input(TEARDOWN, nonexistent_values), expect_success=False)
                self.assertIn("must equal derived Electric slot name", nonexistent.stderr)
                self._assert_installed_state(bindir, env)
                self._drop_slot(bindir, env, REPLICATION_SLOT)

                # An alternate logical slot for this Electric stream blocks
                # the absent-slot rerun path; teardown must report incomplete.
                self._create_slot(bindir, env, slot_name=OTHER_ELECTRIC_SLOT)
                other_stream_slot = self._psql(bindir, env, self._teardown_input(), expect_success=False)
                self.assertIn("other logical slot(s)", other_stream_slot.stderr)
                self._assert_installed_state(bindir, env, expected_slot_count="0")
                self._drop_slot(bindir, env, OTHER_ELECTRIC_SLOT)

                # A non-owner must fail before BEGIN, leaving every resource
                # untouched for the real executor.
                self._create_slot(bindir, env)
                non_owner = self._psql(bindir, non_owner_env, self._teardown_input(), expect_success=False)
                self.assertIn("must own inbox_bridge.summaries", non_owner.stderr)
                self._assert_installed_state(bindir, env)

                # Execute exactly through the transactional COMMIT, then model
                # a process interruption before the non-transactional slot
                # cleanup. The full packet must recover on the next run.
                interrupted_packet = root / "teardown-interrupted-after-commit.sql"
                interrupted_packet.write_text(TEARDOWN.read_text().split("\nCOMMIT;", 1)[0] + "\nCOMMIT;\n")
                partial = self._psql(bindir, env, self._packet_input(interrupted_packet, self._teardown_values()), expect_success=True)
                self.assertEqual(partial.stdout.strip(), "")
                self._assert_transaction_committed_state(bindir, env)

                recovered = self._assert_teardown(bindir, env, scram)
                recovered_receipt = json.loads(recovered.stdout)
                self.assertTrue(recovered_receipt["replication_slot_dropped"])
                self.assertEqual(recovered_receipt["database"], "postgres")
                self.assertEqual(recovered_receipt["slot_name"], REPLICATION_SLOT)
                self.assertEqual(recovered_receipt["plugin"], "pgoutput")
                self.assertEqual(recovered_receipt["replication_slot_action"], "dropped")
                self._assert_teardown_state(bindir, env)

                # A completed teardown is a no-op, including an absent slot,
                # publication, and role, and reports those facts explicitly.
                noop = self._assert_teardown(bindir, env, scram)
                noop_receipt = json.loads(noop.stdout)
                self.assertTrue(noop_receipt["replication_slot_already_absent"])
                self.assertEqual(noop_receipt["replication_slot_action"], "already_absent")
                self.assertTrue(noop_receipt["publication_already_absent"])
                self.assertTrue(noop_receipt["role_already_absent"])
                self._assert_teardown_state(bindir, env)

                # The next install can recreate the removed role/publication.
                self._psql(bindir, env, install, expect_success=True)
                self._create_slot(bindir, env)
                self._assert_teardown(bindir, env, scram)
                self._assert_teardown_state(bindir, env)
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
            scram = "SCRAM-SHA-256$4096:" + "A" * 22 + "==$" + "A" * 43 + "=:" + "B" * 43 + "="
            accepted = subprocess.run(["python3", str(RUNNER), "--packet", "install", "--project-ref", PROJECT_REF], input=scram + "\n", text=True, capture_output=True, env=env, check=False)
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertNotIn(scram, accepted.stdout + accepted.stderr)
            self.assertNotIn(scram, args_file.read_text())
            mismatch = subprocess.run(["python3", str(RUNNER), "--packet", "install", "--project-ref", "copflsklaefwzipsrjqz"], input=scram + "\n", text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(mismatch.returncode, 0)
            self.assertIn("does not match PGHOST", mismatch.stderr)
            self.assertNotIn(scram, mismatch.stdout + mismatch.stderr)

    def test_teardown_rejects_legacy_electric_slot_on_postgres17(self):
        with self._installed_pg17_cluster() as (bindir, env):
            self._create_slot(bindir, env, slot_name=LEGACY_ELECTRIC_SLOT)
            rejected = self._psql(bindir, env, self._teardown_input(), expect_success=False)
            self.assertIn(LEGACY_ELECTRIC_SLOT, rejected.stderr)
            self.assertIn("teardown is incomplete", rejected.stderr)
            self._assert_installed_state(bindir, env, expected_slot_count="0")
            self.assertEqual(self._slot_count(bindir, env, LEGACY_ELECTRIC_SLOT), "1")
            self._drop_slot(bindir, env, LEGACY_ELECTRIC_SLOT)

    def test_teardown_rejects_temporary_style_electric_slot_on_postgres17(self):
        with self._installed_pg17_cluster() as (bindir, env):
            self._create_slot(bindir, env, slot_name=TEMPORARY_ELECTRIC_SLOT)
            rejected = self._psql(bindir, env, self._teardown_input(), expect_success=False)
            self.assertIn(TEMPORARY_ELECTRIC_SLOT, rejected.stderr)
            self.assertIn("teardown is incomplete", rejected.stderr)
            self._assert_installed_state(bindir, env, expected_slot_count="0")
            self.assertEqual(self._slot_count(bindir, env, TEMPORARY_ELECTRIC_SLOT), "1")
            self._drop_slot(bindir, env, TEMPORARY_ELECTRIC_SLOT)

    def test_host_routing_and_tls_overrides_are_refused(self):
        base = {**os.environ, "PGHOST": f"db.{PROJECT_REF}.supabase.co", "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(PINNED_CA), "INBOX_ELECTRIC_PSQL_BIN": "/definitely/missing/psql"}
        for name in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGPORT", "PGOPTIONS", "PGSSLMINPROTOCOLVERSION", "PGGSSENCMODE"):
            env = {**base, name: "attacker-controlled"}
            rejected = subprocess.run(["python3", str(RUNNER), "--packet", "teardown", "--project-ref", PROJECT_REF, "--prior-replica-identity", "d", "--replication-slot", REPLICATION_SLOT], text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn(name, rejected.stderr)
        for key, value in (("PGSSLMODE", "require"), ("PGSSLROOTCERT", str(HERE / "electric-replication-role.production.sql"))):
            env = {**base, key: value}
            rejected = subprocess.run(["python3", str(RUNNER), "--packet", "teardown", "--project-ref", PROJECT_REF, "--prior-replica-identity", "d", "--replication-slot", REPLICATION_SLOT], text=True, capture_output=True, env=env, check=False)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("pinned Supabase CA" if key == "PGSSLROOTCERT" else "verify-full", rejected.stderr)

    def _create_slot(self, bindir: Path, env: dict[str, str], plugin: str = "pgoutput", slot_name: str = REPLICATION_SLOT) -> None:
        self._psql(bindir, env, f"SELECT pg_create_logical_replication_slot('{slot_name}', '{plugin}');", expect_success=True)

    @contextmanager
    def _installed_pg17_cluster(self):
        bindir = postgres_bin()
        if bindir is None:
            if os.environ.get("CI", "").lower() == "true":
                self.fail("PostgreSQL 17 local binaries are required in CI; refusing a silent skip")
            self.skipTest("PostgreSQL 17 local binaries are required")
        with tempfile.TemporaryDirectory(prefix="pg17-") as temp:
            root = Path(temp)
            data = root / "data"
            socket = root / "socket"
            socket.mkdir()
            subprocess.run([bindir / "initdb", "-D", data, "-A", "trust", "-U", "postgres", "--no-locale"], check=True, capture_output=True, text=True)
            log = root / "postgres.log"
            started = subprocess.run([bindir / "pg_ctl", "-D", data, "-l", log, "-o", f"-k {socket} -c listen_addresses='' -c wal_level=logical", "-w", "start"], check=False, capture_output=True, text=True)
            if started.returncode:
                raise AssertionError(f"PostgreSQL 17 failed to start: {started.stderr}\n{log.read_text() if log.exists() else '<missing log>'}")
            admin_env = {**os.environ, "PGHOST": str(socket), "PGUSER": "postgres", "PGDATABASE": "postgres"}
            env = {**admin_env, "PGUSER": EXECUTOR_ROLE}
            try:
                self._psql(
                    bindir,
                    admin_env,
                    "CREATE ROLE inbox_packet_executor LOGIN CREATEROLE REPLICATION BYPASSRLS;"
                    "GRANT CONNECT ON DATABASE postgres TO inbox_packet_executor WITH GRANT OPTION;"
                    "GRANT CREATE ON DATABASE postgres TO inbox_packet_executor;"
                    "CREATE SCHEMA inbox_bridge;"
                    "CREATE TABLE inbox_bridge.summaries (id bigint NOT NULL, body text);"
                    "CREATE UNIQUE INDEX summaries_replica_identity_idx ON inbox_bridge.summaries (id);"
                    "ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY USING INDEX summaries_replica_identity_idx;"
                    "ALTER TABLE inbox_bridge.summaries OWNER TO inbox_packet_executor;"
                    "ALTER SCHEMA inbox_bridge OWNER TO inbox_packet_executor;"
                    "SET password_encryption = 'scram-sha-256';"
                    "CREATE ROLE scram_verifier_source NOLOGIN PASSWORD 'dummy-electric-password';",
                    expect_success=True,
                )
                scram = self._psql(bindir, admin_env, "SELECT rolpassword FROM pg_authid WHERE rolname = 'scram_verifier_source';", expect_success=True).stdout.strip()
                self._psql(
                    bindir,
                    env,
                    self._packet_input(INSTALL, {"project_ref": PROJECT_REF, "connection_project_ref": PROJECT_REF, "electric_password": scram}),
                    expect_success=True,
                )
                self._assert_installed_state(bindir, env, expected_slot_count="0")
                yield bindir, env
            finally:
                subprocess.run([bindir / "pg_ctl", "-D", data, "-w", "stop"], check=True, capture_output=True, text=True)

    def _drop_slot(self, bindir: Path, env: dict[str, str], slot_name: str) -> None:
        for _ in range(20):
            active = self._psql(bindir, env, f"SELECT active FROM pg_replication_slots WHERE slot_name = '{slot_name}';", True).stdout.strip()
            if active != "t":
                self._psql(bindir, env, f"SELECT pg_drop_replication_slot('{slot_name}');", expect_success=True)
                return
            time.sleep(0.1)
        raise AssertionError(f"slot {slot_name} remained active")

    def _slot_count(self, bindir: Path, env: dict[str, str], slot_name: str) -> str:
        return self._psql(bindir, env, f"SELECT count(*) FROM pg_replication_slots WHERE slot_name = '{slot_name}' AND database::text = current_database();", True).stdout.strip()

    def _start_replication(self, bindir: Path, env: dict[str, str]):
        receiver = subprocess.Popen(
            [
                bindir / "pg_recvlogical",
                "--dbname", env["PGDATABASE"],
                "--username", env["PGUSER"],
                "--host", env["PGHOST"],
                "--slot", REPLICATION_SLOT,
                "--start",
                "--file", os.devnull,
                "--plugin", "pgoutput",
                "--option", "proto_version=4",
                "--option", f"publication_names={ELECTRIC_PUBLICATION}",
            ],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        for _ in range(50):
            if receiver.poll() is not None:
                stderr = receiver.stderr.read() if receiver.stderr else ""
                raise AssertionError(f"pg_recvlogical exited before activating slot: {stderr}")
            active = self._psql(bindir, env, f"SELECT active FROM pg_replication_slots WHERE slot_name = '{REPLICATION_SLOT}';", True).stdout.strip()
            if active == "t":
                return receiver
            time.sleep(0.1)
        receiver.terminate()
        receiver.wait(timeout=5)
        stderr = receiver.stderr.read() if receiver.stderr else ""
        raise AssertionError(f"pg_recvlogical did not activate slot: {stderr}")

    def _teardown_values(self) -> dict[str, str]:
        return {
            "project_ref": PROJECT_REF,
            "connection_project_ref": PROJECT_REF,
            "prior_replica_identity": "i",
            "prior_replica_identity_index": "summaries_replica_identity_idx",
            "replication_slot_name": REPLICATION_SLOT,
        }

    def _teardown_input(self) -> str:
        return self._packet_input(TEARDOWN, self._teardown_values())

    def _assert_teardown(self, bindir: Path, env: dict[str, str], scram: str):
        teardown = self._teardown_input()
        result = self._psql(bindir, env, teardown, expect_success=True)
        self.assertNotIn(scram, result.stdout + result.stderr)
        return result

    def _assert_uninstalled_state(self, bindir: Path, env: dict[str, str]) -> None:
        self.assertEqual(self._slot_count(bindir, env, REPLICATION_SLOT), "0")
        self.assertEqual(self._psql(bindir, env, f"SELECT count(*) FROM pg_publication WHERE pubname='{ELECTRIC_PUBLICATION}';", True).stdout.strip(), "0")
        self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM pg_roles WHERE rolname='inbox_electric_replication';", True).stdout.strip(), "0")
        self.assertEqual(self._psql(bindir, env, "SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass;", True).stdout.strip(), "i")

    def _assert_installed_state(self, bindir: Path, env: dict[str, str], expected_slot_count: str = "1") -> None:
        self.assertEqual(self._slot_count(bindir, env, REPLICATION_SLOT), expected_slot_count)
        self.assertEqual(self._psql(bindir, env, f"SELECT count(*) FROM pg_publication WHERE pubname='{ELECTRIC_PUBLICATION}';", True).stdout.strip(), "1")
        self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM pg_roles WHERE rolname='inbox_electric_replication';", True).stdout.strip(), "1")
        self.assertEqual(self._psql(bindir, env, "SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass;", True).stdout.strip(), "f")

    def _assert_transaction_committed_state(self, bindir: Path, env: dict[str, str]) -> None:
        self.assertEqual(self._slot_count(bindir, env, REPLICATION_SLOT), "1")
        self.assertEqual(self._psql(bindir, env, f"SELECT count(*) FROM pg_publication WHERE pubname='{ELECTRIC_PUBLICATION}';", True).stdout.strip(), "0")
        self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM pg_roles WHERE rolname='inbox_electric_replication';", True).stdout.strip(), "0")
        restored = self._psql(bindir, env, "SELECT c.relreplident::text || ':' || coalesce((SELECT c2.relname FROM pg_index i JOIN pg_class c2 ON c2.oid=i.indexrelid WHERE i.indrelid=c.oid AND i.indisreplident), '') FROM pg_class c WHERE c.oid='inbox_bridge.summaries'::regclass;", True).stdout.strip()
        self.assertEqual(restored, "i:summaries_replica_identity_idx")

    def _assert_teardown_state(self, bindir: Path, env: dict[str, str]) -> None:
        self.assertEqual(self._slot_count(bindir, env, REPLICATION_SLOT), "0")
        self.assertEqual(self._psql(bindir, env, f"SELECT count(*) FROM pg_publication WHERE pubname='{ELECTRIC_PUBLICATION}';", True).stdout.strip(), "0")
        self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM pg_roles WHERE rolname='inbox_electric_replication';", True).stdout.strip(), "0")
        restored = self._psql(bindir, env, "SELECT c.relreplident::text || ':' || coalesce((SELECT c2.relname FROM pg_index i JOIN pg_class c2 ON c2.oid=i.indexrelid WHERE i.indrelid=c.oid AND i.indisreplident), '') FROM pg_class c WHERE c.oid='inbox_bridge.summaries'::regclass;", True).stdout.strip()
        self.assertEqual(restored, "i:summaries_replica_identity_idx")

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
