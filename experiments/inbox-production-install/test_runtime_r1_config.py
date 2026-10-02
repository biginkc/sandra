from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
TLS_PROOF = ROOT / "experiments/inbox-production-install/electric-tls-proof.py"


def load_tls_proof():
    spec = importlib.util.spec_from_file_location("electric_tls_proof", TLS_PROOF)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {TLS_PROOF}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RuntimeR1ConfigTests(unittest.TestCase):
    def test_candidate_declares_the_seven_section_one_services(self):
        candidate = json.loads((ROOT / "deployment/inbox/candidate.json").read_text())
        self.assertEqual(
            [service["name"] for service in candidate["services"]],
            [
                "inbox-electric",
                "inbox-restate",
                "inbox-operation-worker",
                "inbox-reply-send-worker",
                "inbox-projection-worker",
                "inbox-restate-register",
                "inbox-sync-relay",
            ],
        )

    def test_production_electric_tls_is_verified_and_secret_is_not_relayed(self):
        candidate_path = ROOT / "deployment/inbox/candidate.json"
        candidate_text = candidate_path.read_text()
        candidate = json.loads(candidate_text)
        electric = next(service for service in candidate["services"] if service["name"] == "inbox-electric")
        reply_worker = next(service for service in candidate["services"] if service["name"] == "inbox-reply-send-worker")
        self.assertNotIn("ELECTRIC_INSECURE", candidate_text)
        self.assertEqual(electric["env"]["DATABASE_URL"], "${INBOX_ELECTRIC_DATABASE_URL}")
        self.assertEqual(electric["env"]["ELECTRIC_DATABASE_CA_CERTIFICATE_FILE"], "${INBOX_ELECTRIC_DATABASE_CA_CERTIFICATE_FILE}")
        self.assertEqual(electric["env"]["ELECTRIC_SECRET"], "${INBOX_ELECTRIC_SECRET}")
        self.assertEqual(electric["secretEnv"], ["INBOX_ELECTRIC_DATABASE_URL", "INBOX_ELECTRIC_SECRET"])
        self.assertEqual(electric["connection"], {
            "host": "db.copflsklaefwzipsrjqz.supabase.co",
            "port": 5432,
            "database": "postgres",
            "sslmode": "require",
            "caCertificateFile": "/etc/sandra-inbox/supabase-prod-ca-2021.crt",
            "secretForwarding": "relay-held-shape-secret",
        })
        self.assertEqual(reply_worker["env"]["INBOX_REPLY_OWNED_RECIPIENTS"], "${INBOX_REPLY_OWNED_RECIPIENTS}")
        relay = next(service for service in candidate["services"] if service["name"] == "inbox-sync-relay")
        self.assertEqual(relay["secretEnv"], ["INBOX_RELAY_TOKEN", "INBOX_ELECTRIC_SECRET"])
        self.assertEqual(relay["env"]["INBOX_ELECTRIC_SECRET"], "${INBOX_ELECTRIC_SECRET}")
        production_env = (ROOT / "deployment/inbox/electric.production.env.example").read_text()
        self.assertNotIn("ELECTRIC_INSECURE", production_env)
        self.assertIn("?sslmode=require", production_env)
        self.assertIn("INBOX_ELECTRIC_DATABASE_CA_CERTIFICATE_FILE=/etc/sandra-inbox/supabase-prod-ca-2021.crt", production_env)
        self.assertIn("INBOX_ELECTRIC_SECRET=", production_env)
        self.assertNotIn("PGPASSFILE", production_env)
        self.assertNotIn("sslrootcert=", production_env)
        self.assertIn("INBOX_ELECTRIC_DATABASE_URL=postgresql://inbox_electric_replication@", production_env)
        self.assertIn("INBOX_ELECTRIC_SECRET name", production_env)

    def test_local_fixture_keeps_insecure_mode_explicitly_scoped(self):
        compose = (ROOT / "experiments/inbox-release/execution-stack-compose.yml").read_text()
        marker = "# FIXTURE ONLY: this compose stack uses its disposable local database."
        self.assertIn(marker, compose)
        self.assertIn('ELECTRIC_INSECURE: "true"', compose)

    def test_vercel_declares_the_one_minute_callback_sweep(self):
        config = json.loads((ROOT / "vercel.json").read_text())
        matching = [cron for cron in config["crons"] if cron["path"] == "/api/cron/inbox-reply-callback-sweep"]
        self.assertEqual(matching, [{"path": "/api/cron/inbox-reply-callback-sweep", "schedule": "*/1 * * * *"}])

    def test_real_electric_proofs_use_the_candidate_pin_and_fail_closed(self):
        candidate = json.loads((ROOT / "deployment/inbox/candidate.json").read_text())
        pinned_image = next(service for service in candidate["services"] if service["name"] == "inbox-electric")["image"]
        for name in ("electric-tls-proof.py", "electric-secret-proof.py"):
            proof = (ROOT / "experiments/inbox-production-install" / name).read_text()
            self.assertIn(pinned_image, proof)
            self.assertIn("PINNED_PULL_DENIED", proof)
            self.assertIn("UNSEALED", proof)

    def test_electric_tls_harness_matches_candidate_dsn_and_ca_contract(self):
        proof = load_tls_proof()
        commands = []

        def fake_docker(*args, check=True, timeout=120):
            commands.append(args)
            return type("Result", (), {"stdout": "", "returncode": 0})()

        proof.docker = fake_docker
        proof.electric_port = lambda _container: 3000
        with self.subTest("start command"):
            proof.start_electric("electric", "image", "network", Path("/tmp/right-ca.crt"), "postgres", "stream")
        run = next(command for command in commands if command[0] == "run")
        database_url = next(value for value in run if value.startswith("DATABASE_URL="))
        self.assertEqual(database_url, "DATABASE_URL=postgresql://postgres:sandra-electric-proof-password@postgres:5432/postgres?sslmode=require")
        self.assertIn("ELECTRIC_DATABASE_CA_CERTIFICATE_FILE=/etc/sandra-inbox/supabase-prod-ca-2021.crt", run)
        self.assertNotIn("sslmode=verify-full", " ".join(run))

    def test_tls_negative_requires_the_case_specific_error_token(self):
        proof = load_tls_proof()
        self.assertTrue(proof.tls_error("{:tls_alert, {:unknown_ca, \"bad CA\"}}", "unknown_ca"))
        self.assertTrue(proof.tls_error("{:tls_alert, {:hostname_check_failed, \"wrong host\"}}", "hostname_check_failed"))
        self.assertFalse(proof.tls_error("ssl connection failed", "unknown_ca"))

    def test_electric_ssl_proof_attributes_tls_to_the_slot_backend(self):
        proof = load_tls_proof()
        queries = []
        proof.psql = lambda _container, sql: queries.append(sql) or "1"
        self.assertEqual(proof.ssl_backend_count("postgres", "stream"), 1)
        query = queries[0]
        self.assertIn("pg_replication_slots", query)
        self.assertIn("s.pid = r.active_pid", query)
        self.assertIn("s.ssl = true", query)
        self.assertNotIn("application_name", query)


if __name__ == "__main__":
    unittest.main()
