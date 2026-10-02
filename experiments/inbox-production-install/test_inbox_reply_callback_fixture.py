from __future__ import annotations

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
PACKET = HERE / "inbox-reply-callback-fixture.sql"
MARKER = "sandra-inbox-r1-callback-gate-test"
MUTATION_MARKER = "sandra-inbox-r1-callback-gate-mutation"


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


SETUP = r"""
CREATE EXTENSION pgcrypto;
CREATE SCHEMA inbox_operations;
CREATE FUNCTION inbox_operations.immutable_row() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
CREATE SCHEMA inbox_reply_review;
CREATE TABLE inbox_reply_review.preparations(
 id uuid PRIMARY KEY, org_id uuid NOT NULL, requester_id uuid NOT NULL, request_key uuid NOT NULL,
 input_hash text NOT NULL, canonical_input text NOT NULL, items jsonb NOT NULL, expires_at timestamptz NOT NULL,
 UNIQUE(org_id,id)
);
CREATE TRIGGER immutable_reply_preparation BEFORE UPDATE OR DELETE ON inbox_reply_review.preparations FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE SCHEMA inbox_reply_send;
CREATE TABLE inbox_reply_send.operations(
 org_id uuid NOT NULL, id uuid NOT NULL, requester_id uuid NOT NULL, preparation_id uuid NOT NULL,
 idempotency_key uuid NOT NULL, created_at timestamptz DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,id), FOREIGN KEY(org_id,preparation_id) REFERENCES inbox_reply_review.preparations(org_id,id)
);
CREATE TRIGGER immutable_reply_send_operation BEFORE UPDATE OR DELETE ON inbox_reply_send.operations FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE TABLE inbox_reply_send.attempts(
 org_id uuid NOT NULL, id uuid NOT NULL PRIMARY KEY, operation_id uuid NOT NULL, preparation_id uuid NOT NULL,
 item_id uuid NOT NULL, attempt_ordinal integer NOT NULL, prior_attempt_id uuid, contact_id uuid NOT NULL,
 from_e164 text NOT NULL, to_e164 text NOT NULL, body_hash text NOT NULL, state text NOT NULL,
 generation bigint NOT NULL, lease_until timestamptz, dispatch_started_at timestamptz, dispatch_token uuid,
 receipt_version bigint NOT NULL, provider_reference text, provider_status text, evidence text,
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_reply_send.operations(org_id,id),
 CONSTRAINT provider_reference_unique UNIQUE(provider_reference)
);
CREATE FUNCTION reject_unapproved_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable'; END IF; IF NEW.state <> 'approved' THEN RAISE EXCEPTION 'Invalid initial send attempt state'; END IF; RETURN NEW; END $$;
CREATE TRIGGER guard_reply_send_attempt BEFORE INSERT OR DELETE ON inbox_reply_send.attempts FOR EACH ROW EXECUTE FUNCTION reject_unapproved_attempt();
CREATE TABLE inbox_reply_send.unmatched_callbacks(
 provider text NOT NULL, provider_reference text NOT NULL, terminal_status text NOT NULL, payload jsonb NOT NULL,
 PRIMARY KEY(provider,provider_reference)
);
CREATE TABLE inbox_reply_review.admission(enabled boolean NOT NULL);
INSERT INTO inbox_reply_review.admission VALUES(false);
"""


@unittest.skipUnless(postgres_bin() is not None, "PostgreSQL 17 local binaries are required")
class ReplyCallbackFixtureTests(unittest.TestCase):
    def test_owned_fixture_creates_exact_rows_and_removes_only_its_marker(self):
        bindir = postgres_bin()
        assert bindir is not None
        with tempfile.TemporaryDirectory(prefix="sandra-callback-fixture-pg17-") as temp:
            root = Path(temp)
            data = root / "data"
            socket = Path("/tmp") / f"sandra-callback-{os.getpid()}"
            if socket.exists():
                shutil.rmtree(socket)
            socket.mkdir()
            subprocess.run([bindir / "initdb", "-D", data, "-A", "trust", "-U", "postgres", "--no-locale"], check=True, capture_output=True, text=True)
            subprocess.run([bindir / "pg_ctl", "-D", data, "-l", root / "postgres.log", "-o", f"-k {socket} -c listen_addresses=''", "-w", "start"], check=True, capture_output=True, text=True)
            env = {**os.environ, "PGHOST": str(socket), "PGUSER": "postgres", "PGDATABASE": "postgres"}
            try:
                self._psql(bindir, env, SETUP)
                self._run(bindir, env, "create", MARKER)
                self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM inbox_reply_send.attempts WHERE state='provider_accepted';").stdout.strip(), "2")
                self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE payload->>'__sandra_fixture_marker'='" + MARKER + "';").stdout.strip(), "1")
                self.assertEqual(self._psql(bindir, env, "SELECT count(*) FROM inbox_reply_send.r1_callback_gate_fixtures WHERE marker='" + MARKER + "';").stdout.strip(), "1")
                self.assertEqual(self._psql(bindir, env, "SELECT enabled FROM inbox_reply_review.admission;").stdout.strip(), "f")
                self._run(bindir, env, "remove", MARKER)
                for query in (
                    f"SELECT count(*) FROM inbox_reply_send.attempts WHERE evidence='sandra_r1_callback_gate';",
                    f"SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE payload->>'__sandra_fixture_marker'='{MARKER}';",
                    f"SELECT count(*) FROM inbox_reply_send.r1_callback_gate_fixtures WHERE marker='{MARKER}';",
                ):
                    self.assertEqual(self._psql(bindir, env, query).stdout.strip(), "0")
                self.assertEqual(self._psql(bindir, env, "SELECT enabled FROM inbox_reply_review.admission;").stdout.strip(), "f")

                mutated = root / "mutated.sql"
                mutated.write_text(PACKET.read_text().replace("ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;", "-- natural mutation: the guard is no longer disabled;", 1))
                rejected = subprocess.run([bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "fixture_create=true", "-v", "fixture_action=create", "-v", f"fixture_marker={MUTATION_MARKER}", "-f", mutated], env=env, capture_output=True, text=True)
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("Invalid initial send attempt state", rejected.stderr)
            finally:
                subprocess.run([bindir / "pg_ctl", "-D", data, "-w", "stop"], check=True, capture_output=True, text=True)
                shutil.rmtree(socket, ignore_errors=True)

    def _run(self, bindir: Path, env: dict[str, str], action: str, marker: str):
        fixture_create = "true" if action == "create" else "false"
        result = subprocess.run([bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", f"fixture_create={fixture_create}", "-v", f"fixture_action={action}", "-v", f"fixture_marker={marker}", "-f", PACKET], env=env, capture_output=True, text=True)
        if result.returncode != 0:
            self.fail(result.stderr)

    def _psql(self, bindir: Path, env: dict[str, str], sql: str) -> subprocess.CompletedProcess[str]:
        result = subprocess.run([bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql], env=env, capture_output=True, text=True)
        if result.returncode != 0:
            self.fail(result.stderr)
        return result


if __name__ == "__main__":
    unittest.main()
