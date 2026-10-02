from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).resolve().parents[2]
PROOF_DIR = ROOT / "experiments/inbox-production-install"
TLS_PROOF = PROOF_DIR / "electric-tls-proof.py"
SECRET_PROOF = PROOF_DIR / "electric-secret-proof.py"
if str(PROOF_DIR) not in sys.path:
    sys.path.insert(0, str(PROOF_DIR))
from electric_image_contract import (  # noqa: E402
    CandidateError,
    EIMG_ATTESTATION_PLACEHOLDER,
    EIMG_DIGEST_PLACEHOLDER,
    EIMG_LABELS,
    EIMG_REPOSITORY,
    EIMG_SOURCE_COMMIT,
    ElectricImagePin,
    load_electric_pin,
)


def load_tls_proof():
    spec = importlib.util.spec_from_file_location("electric_tls_proof", TLS_PROOF)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {TLS_PROOF}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_secret_proof():
    spec = importlib.util.spec_from_file_location("electric_secret_proof", SECRET_PROOF)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {SECRET_PROOF}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ready_pin() -> ElectricImagePin:
    digest = "a" * 64
    return ElectricImagePin(
        image=f"{EIMG_REPOSITORY}:1.8.1-0f40420@sha256:{digest}",
        repository_digest=f"{EIMG_REPOSITORY}@sha256:{digest}",
        digest=digest,
        source_commit=EIMG_SOURCE_COMMIT,
        attestation="https://github.com/biginkc/sandra/actions/runs/756",
    )


def attestation_payload(*, source_commit: str = EIMG_SOURCE_COMMIT, workflow: str = "https://github.com/biginkc/sandra/.github/workflows/inbox-electric.yml@refs/heads/main") -> list[dict]:
    return [{
        "verificationResult": {
            "signature": {"certificate": {
                "sourceRepository": "https://github.com/biginkc/sandra",
                "sourceRepositoryOwner": "biginkc",
                "subjectAlternativeName": workflow,
            }},
            "statement": {"predicate": {"buildDefinition": {"resolvedDependencies": [{
                "uri": f"git+https://github.com/electric-sql/electric@{source_commit}",
                "digest": {"sha1": source_commit},
            }]}}},
        },
    }]


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
        self.assertEqual(pinned_image, f"{EIMG_REPOSITORY}:1.8.1-0f40420@sha256:{EIMG_DIGEST_PLACEHOLDER}")
        self.assertEqual(next(service for service in candidate["services"] if service["name"] == "inbox-electric")["sourceCommit"], EIMG_SOURCE_COMMIT)
        self.assertEqual(next(service for service in candidate["services"] if service["name"] == "inbox-electric")["attestation"], EIMG_ATTESTATION_PLACEHOLDER)
        with self.assertRaises(CandidateError):
            load_electric_pin(require_ready=True)
        for name in ("electric-tls-proof.py", "electric-secret-proof.py"):
            proof = (ROOT / "experiments/inbox-production-install" / name).read_text()
            self.assertNotIn("efb6fa43", proof)
            self.assertIn("load_electric_pin", proof)
            self.assertIn("gh", proof)
            self.assertIn("verify_labels", proof)
            self.assertIn("PINNED_PULL_DENIED", proof)
            self.assertIn("UNSEALED", proof)

    def test_candidate_contract_rejects_placeholder_for_a_sealed_consumer(self):
        pin = load_electric_pin()
        self.assertTrue(pin.pending)
        self.assertEqual(pin.digest, EIMG_DIGEST_PLACEHOLDER)
        self.assertEqual(pin.attestation, EIMG_ATTESTATION_PLACEHOLDER)
        with self.assertRaisesRegex(CandidateError, "EIMG_BUILD_PENDING"):
            pin.require_ready()

    def test_each_proof_requires_repo_digest_match(self):
        for proof in (load_tls_proof(), load_secret_proof()):
            with self.subTest(proof=proof.__name__):
                proof.docker = lambda *args, **kwargs: SimpleNamespace(stdout="ghcr.io/biginkc/inbox-electric@sha256:" + "b" * 64, stderr="", returncode=0)
                with self.assertRaisesRegex(proof.ProofError, "PINNED_REPO_DIGEST_MISMATCH"):
                    proof.inspect_repo_digest("image", ready_pin().repository_digest)

    def test_each_proof_requires_a_passing_attestation_and_exact_identity(self):
        for proof in (load_tls_proof(), load_secret_proof()):
            with self.subTest(proof=proof.__name__):
                commands = []

                def fake_run(args, check=True, timeout=120):
                    commands.append(args)
                    return SimpleNamespace(stdout=json.dumps(attestation_payload()), stderr="", returncode=0)

                proof.run = fake_run
                result = proof.verify_attestation(ready_pin())
                self.assertEqual(result["source_commit"], EIMG_SOURCE_COMMIT)
                self.assertIn("--owner", commands[0])
                self.assertIn("biginkc", commands[0])
                self.assertIn("--signer-repo", commands[0])
                self.assertIn("oci://ghcr.io/biginkc/inbox-electric@sha256:" + "a" * 64, commands[0])

                for mutated in (
                    attestation_payload(source_commit="b" * 40),
                    attestation_payload(workflow="https://github.com/biginkc/sandra/.github/workflows/inbox-electric.yml@refs/heads/dev"),
                ):
                    proof.run = lambda args, check=True, timeout=120, payload=mutated: SimpleNamespace(stdout=json.dumps(payload), stderr="", returncode=0)
                    with self.assertRaisesRegex(proof.ProofError, "attestation identity/source commit"):
                        proof.verify_attestation(ready_pin())

                proof.run = lambda *args, **kwargs: SimpleNamespace(stdout="", stderr="signature rejected", returncode=1)
                with self.assertRaisesRegex(proof.ProofError, "EIMG_ATTESTATION_FAILED"):
                    proof.verify_attestation(ready_pin())

    def test_each_proof_requires_all_eimg6_labels(self):
        for proof in (load_tls_proof(), load_secret_proof()):
            for key in EIMG_LABELS:
                with self.subTest(proof=proof.__name__, label=key):
                    labels = dict(EIMG_LABELS)
                    labels[key] = "mutated"

                    def fake_docker(*args, labels=labels, **kwargs):
                        return SimpleNamespace(stdout=json.dumps(labels), stderr="", returncode=0)

                    proof.docker = fake_docker
                    with self.assertRaisesRegex(proof.ProofError, "OCI labels do not match EIMG-6"):
                        proof.verify_labels(ready_pin(), ready_pin().image)

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
