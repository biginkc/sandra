from __future__ import annotations

import json
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]


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
            "secretForwarding": "none",
        })
        self.assertEqual(reply_worker["env"]["INBOX_REPLY_OWNED_RECIPIENTS"], "${INBOX_REPLY_OWNED_RECIPIENTS}")
        production_env = (ROOT / "deployment/inbox/electric.production.env.example").read_text()
        self.assertNotIn("ELECTRIC_INSECURE", production_env)
        self.assertIn("?sslmode=require", production_env)
        self.assertIn("INBOX_ELECTRIC_DATABASE_CA_CERTIFICATE_FILE=/etc/sandra-inbox/supabase-prod-ca-2021.crt", production_env)
        self.assertIn("INBOX_ELECTRIC_SECRET=", production_env)
        self.assertNotIn("PGPASSFILE", production_env)
        self.assertNotIn("sslrootcert=", production_env)
        self.assertIn("INBOX_ELECTRIC_DATABASE_URL=postgresql://inbox_electric_replication@", production_env)
        self.assertIn("no Electric secret is forwarded", production_env)

    def test_local_fixture_keeps_insecure_mode_explicitly_scoped(self):
        compose = (ROOT / "experiments/inbox-release/execution-stack-compose.yml").read_text()
        marker = "# FIXTURE ONLY: this compose stack uses its disposable local database."
        self.assertIn(marker, compose)
        self.assertIn('ELECTRIC_INSECURE: "true"', compose)

    def test_vercel_declares_the_one_minute_callback_sweep(self):
        config = json.loads((ROOT / "vercel.json").read_text())
        matching = [cron for cron in config["crons"] if cron["path"] == "/api/cron/inbox-reply-callback-sweep"]
        self.assertEqual(matching, [{"path": "/api/cron/inbox-reply-callback-sweep", "schedule": "*/1 * * * *"}])


if __name__ == "__main__":
    unittest.main()
