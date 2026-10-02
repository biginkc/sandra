from __future__ import annotations

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import time
import unittest


HERE = Path(__file__).resolve().parent
PACKET = HERE / "runtime-worker-logins.sql"
RUNNER = HERE / "run-runtime-worker-logins.py"
PINNED_CA = HERE / "supabase-prod-ca-2021.crt"
PROJECT_REF = "ncsngxlcyxylaeskiteu"
SCRAM = [
    "SCRAM-SHA-256$4096:aaaaaaaaaaaaaaaaaaaaaa==$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb=:ccccccccccccccccccccccccccccccccccccccccccc=",
    "SCRAM-SHA-256$4096:dddddddddddddddddddddd==$eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee=:fffffffffffffffffffffffffffffffffffffffffff=",
    "SCRAM-SHA-256$4096:gggggggggggggggggggggg==$hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh=:iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii=",
]


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


class RuntimeWorkerLoginTests(unittest.TestCase):
    def test_runner_accepts_three_stdin_verifiers_and_redacts_child_output(self):
        with tempfile.TemporaryDirectory(prefix="sandra-runtime-login-runner-") as temp:
            root = Path(temp)
            child = root / "fake-psql.py"
            captured = root / "captured.sql"
            child.write_text(
                "#!/usr/bin/env python3\n"
                "import pathlib, sys\n"
                f"value = sys.stdin.read(); pathlib.Path({str(captured)!r}).write_text(value); print(value, end='')\n"
            )
            child.chmod(0o700)
            result = subprocess.run(
                ["python3", str(RUNNER), "--project-ref", PROJECT_REF],
                input="\n".join(SCRAM) + "\n",
                text=True,
                capture_output=True,
                env={
                    **os.environ,
                    "PGHOST": f"db.{PROJECT_REF}.supabase.co",
                    "PGSSLMODE": "verify-full",
                    "PGSSLROOTCERT": str(PINNED_CA),
                    "INBOX_RUNTIME_LOGINS_PSQL_BIN": str(child),
                },
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("SCRAM-SHA-256$", result.stdout + result.stderr)
            packet_input = captured.read_text()
            self.assertIn("\\set action_verifier", packet_input)
            self.assertIn("runtime-worker-logins.sql", packet_input)

    def test_runner_rejects_wrong_stdin_arity_before_invoking_psql(self):
        result = subprocess.run(
            ["python3", str(RUNNER), "--project-ref", PROJECT_REF],
            input=SCRAM[0] + "\n" + SCRAM[1] + "\n",
            text=True,
            capture_output=True,
            env={**os.environ, "PGHOST": f"db.{PROJECT_REF}.supabase.co", "PGSSLMODE": "verify-full", "PGSSLROOTCERT": str(PINNED_CA)},
        )
        self.assertEqual(result.returncode, 3)
        self.assertIn("exactly three", result.stderr)

    @unittest.skipUnless(postgres_bin() is not None, "PostgreSQL 17 local binaries are required")
    def test_packet_sets_login_roles_and_two_generation_limits_on_postgres17(self):
        bindir = postgres_bin()
        assert bindir is not None
        with tempfile.TemporaryDirectory(prefix="sandra-runtime-logins-pg17-") as temp:
            root = Path(temp)
            data = root / "data"
            socket = Path("/tmp") / f"sandra-rwl-{os.getpid()}"
            if socket.exists():
                shutil.rmtree(socket)
            socket.mkdir()
            subprocess.run([bindir / "initdb", "-D", data, "-A", "trust", "-U", "postgres", "--no-locale"], check=True, capture_output=True, text=True)
            log = root / "postgres.log"
            subprocess.run([bindir / "pg_ctl", "-D", data, "-l", log, "-o", f"-k {socket} -c listen_addresses=''", "-w", "start"], check=True, capture_output=True, text=True)
            admin_env = {**os.environ, "PGHOST": str(socket), "PGUSER": "postgres", "PGDATABASE": "postgres"}
            try:
                self._psql(bindir, admin_env, "CREATE ROLE inbox_action_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; CREATE ROLE inbox_reply_send_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; CREATE ROLE inbox_projection_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT;")
                packet = "\n".join(f"\\set {name} '{value}'" for name, value in zip(("action_verifier", "reply_verifier", "projection_verifier"), SCRAM)) + f"\n\\i '{PACKET}'\n"
                self._psql(bindir, admin_env, packet)
                rows = self._psql(bindir, admin_env, "SELECT rolname, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname IN ('inbox_action_worker','inbox_reply_send_worker','inbox_projection_login','inbox_projection_worker') ORDER BY rolname;").stdout.splitlines()
                self.assertEqual(rows, ["inbox_action_worker|t|4", "inbox_projection_login|t|2", "inbox_projection_worker|f|-1", "inbox_reply_send_worker|t|4"])
                self.assertEqual(self._psql(bindir, admin_env, "SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member JOIN pg_roles p ON p.oid=m.roleid WHERE r.rolname='inbox_projection_login' AND p.rolname='inbox_projection_worker' AND NOT m.admin_option;").stdout.strip(), "1")

                # Two generations of two-connection worker pools fit exactly;
                # a third generation cannot establish another pool.
                self._assert_connection_limit(bindir, admin_env, "inbox_action_worker", 4, 2)
                self._assert_connection_limit(bindir, admin_env, "inbox_reply_send_worker", 4, 2)
                self._assert_connection_limit(bindir, admin_env, "inbox_projection_login", 2, 1)
            finally:
                subprocess.run([bindir / "pg_ctl", "-D", data, "-w", "stop"], check=True, capture_output=True, text=True)
                shutil.rmtree(socket, ignore_errors=True)

    def _psql(self, bindir: Path, env: dict[str, str], input_text: str, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run([bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "|", "-f", "-"], input=input_text, text=True, capture_output=True, env=env)
        if expect_success and result.returncode != 0:
            self.fail(result.stderr)
        return result

    def _assert_connection_limit(self, bindir: Path, admin_env: dict[str, str], role: str, limit: int, pool_size: int):
        self.assertEqual(limit, 2 * pool_size)
        sessions = [subprocess.Popen([bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "SELECT pg_sleep(2);"], env={**admin_env, "PGUSER": role}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True) for _ in range(limit)]
        try:
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                count = self._psql(bindir, admin_env, f"SELECT count(*) FROM pg_stat_activity WHERE usename='{role}';").stdout.strip()
                if int(count) >= limit:
                    break
                time.sleep(0.05)
            else:
                self.fail(f"did not establish {limit} {role} sessions")
            overflow = subprocess.run([bindir / "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c", "SELECT 1;"], env={**admin_env, "PGUSER": role}, capture_output=True, text=True)
            self.assertNotEqual(overflow.returncode, 0)
            self.assertIn("too many connections", overflow.stderr)
        finally:
            for session in sessions:
                session.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
