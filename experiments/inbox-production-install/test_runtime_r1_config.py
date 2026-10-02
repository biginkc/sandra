from __future__ import annotations

import base64
import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import textwrap
import unittest


ROOT = Path(__file__).resolve().parents[2]
PROOF_DIR = ROOT / "experiments/inbox-production-install"
TLS_PROOF = PROOF_DIR / "electric-tls-proof.py"
SECRET_PROOF = PROOF_DIR / "electric-secret-proof.py"
SANDRA_COMMIT = "d309bec7fcc9a1cf493ae22434d3f891d6989138"
if str(PROOF_DIR) not in sys.path:
    sys.path.insert(0, str(PROOF_DIR))
from electric_image_contract import (  # noqa: E402
    CandidateError,
    EIMG_ATTESTATION_PLACEHOLDER,
    EIMG_DIGEST_PLACEHOLDER,
    EIMG_LABELS,
    EIMG_REPOSITORY,
    EIMG_SIGNER_WORKFLOW,
    EIMG_SOURCE_COMMIT,
    EIMG_SOURCE_REF,
    EIMG_WORKFLOW_PATH,
    ElectricImagePin,
    load_electric_pin,
    verify_attestation_json,
    verify_run_evidence_json,
    verify_workflow_text,
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


def attestation_payload() -> list[dict]:
    return json.loads((PROOF_DIR / "electric-attestation-fixture.json").read_text())


def workflow_fixture() -> str:
    return textwrap.dedent(
        f"""
        name: Build Sandra Inbox Electric image
        on:
          workflow_dispatch: {{}}
        jobs:
          build:
            runs-on: ubuntu-24.04
            steps:
              - name: Check out pinned upstream Electric source
                uses: actions/checkout@pinned
                with:
                  repository: electric-sql/electric
                  ref: {EIMG_SOURCE_COMMIT}
              - name: Verify pinned upstream source and release tag
                working-directory: electric
                shell: bash
                env:
                  EXPECTED_COMMIT: {EIMG_SOURCE_COMMIT}
                  UPSTREAM_REPO: https://github.com/electric-sql/electric.git
                run: |
                  set -euo pipefail
                  checked_out="$(git rev-parse HEAD)"
                  [[ "$checked_out" == "$EXPECTED_COMMIT" ]] || {{
                    echo "checked out $checked_out, expected $EXPECTED_COMMIT" >&2
                    exit 1
                  }}
                  local_tag_commit="$(git rev-parse '@core/sync-service@1.8.1^{{commit}}')"
                  [[ "$local_tag_commit" == "$EXPECTED_COMMIT" ]] || {{
                    echo "local release tag resolved to $local_tag_commit, expected $EXPECTED_COMMIT" >&2
                    exit 1
                  }}
                  tag_commit="$(git ls-remote "$UPSTREAM_REPO" 'refs/tags/@core/sync-service@1.8.1^{{}}' | awk 'NR == 1 {{ print $1 }}')"
                  [[ "$tag_commit" =~ ^[a-f0-9]{{40}}$ ]] || {{
                    echo "release tag did not resolve to one commit: $tag_commit" >&2
                    exit 1
                  }}
                  [[ "$tag_commit" == "$EXPECTED_COMMIT" ]] || {{
                    echo "release tag resolved to $tag_commit, expected $EXPECTED_COMMIT" >&2
                    exit 1
                  }}
        """
    )


def run_payload(*, conclusion: str = "success", head_sha: str = SANDRA_COMMIT, head_branch: str = "main", path: str = EIMG_WORKFLOW_PATH) -> dict:
    return {
        "conclusion": conclusion,
        "head_sha": head_sha,
        "head_branch": head_branch,
        "path": path,
    }


def evidence_payload(pin: ElectricImagePin, *, run_id: int = 756) -> dict:
    return {
        "image": pin.repository_digest,
        "upstream_commit": EIMG_SOURCE_COMMIT,
        "tag_check_result": "passed",
        "tag_check": {"resolved_commit": EIMG_SOURCE_COMMIT},
        "workflow_run_id": run_id,
    }


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

    def test_compose_and_manifest_electric_images_resolve_from_candidate(self):
        candidate_image = load_electric_pin().image
        compose = (ROOT / "experiments/inbox-release/execution-stack-compose.yml").read_text()
        manifest = json.loads((ROOT / "experiments/inbox-release/execution-stack-manifest.json").read_text())
        self.assertIn("${INBOX_ELECTRIC_IMAGE:", compose)
        self.assertNotIn(candidate_image, compose)
        self.assertEqual(manifest["runtime_definition"]["services"]["electric"]["image"], candidate_image)
        compose_image_line = next(line.strip() for line in compose.splitlines() if line.strip().startswith("image: ${INBOX_ELECTRIC_IMAGE:"))
        compose_expression = "${INBOX_ELECTRIC_IMAGE:?set INBOX_ELECTRIC_IMAGE from deployment/inbox/candidate.json}"
        self.assertEqual(compose_image_line, f"image: {compose_expression}")
        resolved_compose_image = compose_image_line.removeprefix("image: ").replace(compose_expression, candidate_image)
        self.assertEqual(resolved_compose_image, candidate_image)

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

    def test_real_shaped_attestation_fixture_passes_and_old_schema_fails(self):
        pin = ready_pin()
        payload = attestation_payload()
        result = verify_attestation_json(pin, payload)
        self.assertEqual(result["source_repository_digest"], SANDRA_COMMIT)
        self.assertEqual(result["run_id"], 756)
        old_schema = [{
            "verificationResult": {
                "signature": {"certificate": {
                    "sourceRepository": "https://github.com/biginkc/sandra",
                    "sourceRepositoryUri": "https://github.com/biginkc/sandra",
                }},
                "statement": {"predicate": {"buildDefinition": {"resolvedDependencies": [{
                    "uri": f"git+https://github.com/electric-sql/electric@{EIMG_SOURCE_COMMIT}",
                    "digest": {"sha1": EIMG_SOURCE_COMMIT},
                }]}}},
            },
        }]
        with self.assertRaisesRegex(CandidateError, "EIMG_ATTESTATION_IDENTITY_FAILED"):
            verify_attestation_json(pin, old_schema)

    def test_sandra_source_commit_is_distinct_and_never_confused_with_upstream(self):
        self.assertNotEqual(SANDRA_COMMIT, EIMG_SOURCE_COMMIT)
        certificate = attestation_payload()[0]["verificationResult"]["signature"]["certificate"]
        self.assertEqual(certificate["sourceRepositoryDigest"], SANDRA_COMMIT)
        self.assertEqual(certificate["buildSignerDigest"], SANDRA_COMMIT)
        with self.assertRaisesRegex(CandidateError, "EIMG_RUN_EVIDENCE_FAILED"):
            verify_run_evidence_json(
                ready_pin(),
                {"source_repository_digest": EIMG_SOURCE_COMMIT, "run_id": 756},
                run_payload(),
                evidence_payload(ready_pin()),
            )

    def test_attestation_one_field_negatives_and_predicate_tamper(self):
        pin = ready_pin()
        mutations = {
            "fork": lambda payload: payload[0]["verificationResult"]["signature"]["certificate"].update(sourceRepositoryURI="https://github.com/evil/sandra"),
            "source ref": lambda payload: payload[0]["verificationResult"]["signature"]["certificate"].update(sourceRepositoryRef="refs/heads/dev"),
            "workflow": lambda payload: payload[0]["verificationResult"]["signature"]["certificate"].update(buildSignerURI="https://github.com/biginkc/sandra/.github/workflows/other.yml@refs/heads/main"),
            "runner": lambda payload: payload[0]["verificationResult"]["signature"]["certificate"].update(runnerEnvironment="self-hosted"),
            "signer digest": lambda payload: payload[0]["verificationResult"]["signature"]["certificate"].update(buildSignerDigest="b" * 40),
            "subject": lambda payload: payload[0]["verificationResult"]["statement"]["subject"][0]["digest"].update(sha256="b" * 64),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                payload = copy.deepcopy(attestation_payload())
                mutate(payload)
                with self.assertRaisesRegex(CandidateError, "EIMG_ATTESTATION_IDENTITY_FAILED"):
                    verify_attestation_json(pin, payload)
        with self.assertRaisesRegex(CandidateError, "EIMG_ATTESTATION_IDENTITY_FAILED"):
            verify_attestation_json(pin, [])

        bad_predicate_and_certificate = copy.deepcopy(attestation_payload())
        bad_predicate_and_certificate[0]["verificationResult"]["statement"]["predicate"] = {"resolvedDependencies": [{"uri": "git+https://github.com/electric-sql/electric@0f40420", "digest": {"sha1": "bad"}}]}
        bad_predicate_and_certificate[0]["verificationResult"]["signature"]["certificate"]["sourceRepositoryURI"] = "https://github.com/evil/sandra"
        with self.assertRaisesRegex(CandidateError, "EIMG_ATTESTATION_IDENTITY_FAILED"):
            verify_attestation_json(pin, bad_predicate_and_certificate)

        predicate_tampered = copy.deepcopy(attestation_payload())
        predicate_tampered[0]["verificationResult"]["statement"]["predicate"] = {"anything": "workflow-controlled"}
        self.assertEqual(verify_attestation_json(pin, predicate_tampered)["run_id"], 756)

    def test_each_proof_invokes_the_exact_a2_attestation_command(self):
        for proof in (load_tls_proof(), load_secret_proof()):
            with self.subTest(proof=proof.__name__):
                commands = []

                def fake_run(args, check=True, timeout=120):
                    commands.append(args)
                    return SimpleNamespace(stdout=json.dumps(attestation_payload()), stderr="", returncode=0)

                proof.run = fake_run
                result = proof.verify_attestation(ready_pin())
                self.assertEqual(result["source_commit"], SANDRA_COMMIT)
                self.assertEqual(commands[0], [
                    "gh", "attestation", "verify", ready_pin().oci_uri,
                    "--owner", "biginkc",
                    "--signer-workflow", EIMG_SIGNER_WORKFLOW,
                    "--source-ref", EIMG_SOURCE_REF,
                    "--deny-self-hosted-runners",
                    "--format", "json",
                ])

                proof.run = lambda *args, **kwargs: SimpleNamespace(stdout=json.dumps([]), stderr="", returncode=0)
                with self.assertRaisesRegex(proof.ProofError, "EIMG_ATTESTATION_IDENTITY_FAILED"):
                    proof.verify_attestation(ready_pin())

                proof.run = lambda *args, **kwargs: SimpleNamespace(stdout="", stderr="signature rejected", returncode=1)
                with self.assertRaisesRegex(proof.ProofError, "EIMG_ATTESTATION_FAILED"):
                    proof.verify_attestation(ready_pin())

    def test_workflow_at_s_and_run_evidence_acceptance_matrix(self):
        self.assertEqual(verify_workflow_text(workflow_fixture())["source_commit"], EIMG_SOURCE_COMMIT)
        workflow_mutations = {
            "expected commit": workflow_fixture().replace(f"EXPECTED_COMMIT: {EIMG_SOURCE_COMMIT}", "EXPECTED_COMMIT: " + "b" * 40),
            "checkout ref": workflow_fixture().replace(f"ref: {EIMG_SOURCE_COMMIT}", "ref: " + "b" * 40),
            "tag compare removed": workflow_fixture().replace('[[ "$tag_commit" == "$EXPECTED_COMMIT" ]] || {', '[[ "$tag_commit" == "$EXPECTED_COMMIT" ]]'),
            "guard exits replaced": workflow_fixture().replace("exit 1", "true"),
            "set +e": workflow_fixture().replace("set -euo pipefail", "set -euo pipefail\n                  set +e"),
            "|| true": workflow_fixture().replace('[[ "$tag_commit" == "$EXPECTED_COMMIT" ]] || {', '[[ "$tag_commit" == "$EXPECTED_COMMIT" ]] || true'),
            "exit 0": workflow_fixture().replace("exit 1", "exit 0", 1),
            "continue on error": workflow_fixture().replace("        run: |", "        continue-on-error: true\n        run: |"),
            "file missing": workflow_fixture().replace("- name: Verify pinned upstream source and release tag", "- name: Other step"),
        }
        for name, mutated in workflow_mutations.items():
            with self.subTest(name=name):
                with self.assertRaisesRegex(CandidateError, "EIMG_WORKFLOW_FAILED"):
                    verify_workflow_text(mutated)

        for proof in (load_tls_proof(), load_secret_proof()):
            with self.subTest(proof=proof.__name__, name="workflow file 404"):
                proof.run = lambda *args, **kwargs: SimpleNamespace(stdout="", stderr="not found", returncode=1)
                with self.assertRaisesRegex(proof.ProofError, "EIMG_WORKFLOW_FAILED"):
                    proof.verify_workflow_at_commit({"source_repository_digest": SANDRA_COMMIT})
            with self.subTest(proof=proof.__name__, name="workflow gh api fallback source"):
                def fake_workflow_lookup(args, **kwargs):
                    if args[:2] == ["git", "-C"]:
                        return SimpleNamespace(stdout="", stderr="not found", returncode=1)
                    self.assertEqual(args[:2], ["gh", "api"])
                    return SimpleNamespace(
                        stdout=base64.b64encode(workflow_fixture().encode()).decode(),
                        stderr="",
                        returncode=0,
                    )

                proof.run = fake_workflow_lookup
                self.assertEqual(
                    proof.verify_workflow_at_commit({"source_repository_digest": SANDRA_COMMIT})["workflow_source"],
                    "gh api",
                )

        pin = ready_pin()
        attestation = {"source_repository_digest": SANDRA_COMMIT, "run_id": 756}
        self.assertEqual(verify_run_evidence_json(pin, attestation, run_payload(), evidence_payload(pin))["artifact"]["tag_check_result"], "passed")
        negative_runs = {
            "tag result": (run_payload(), {**evidence_payload(pin), "tag_check_result": "failed"}),
            "run id": (run_payload(), {**evidence_payload(pin), "workflow_run_id": 757}),
            "image": (run_payload(), {**evidence_payload(pin), "image": "ghcr.io/biginkc/inbox-electric@sha256:" + "b" * 64}),
            "conclusion": (run_payload(conclusion="failure"), evidence_payload(pin)),
            "head sha": (run_payload(head_sha="b" * 40), evidence_payload(pin)),
            "head branch": (run_payload(head_branch="feature"), evidence_payload(pin)),
            "path": (run_payload(path=".github/workflows/other.yml"), evidence_payload(pin)),
            "artifact absent": (run_payload(), None),
        }
        for name, (run_value, artifact_value) in negative_runs.items():
            with self.subTest(name=name):
                with self.assertRaisesRegex(CandidateError, "EIMG_RUN_EVIDENCE_FAILED"):
                    verify_run_evidence_json(pin, attestation, run_value, artifact_value)

    def _run_fake_main(self, proof, failure: str | None) -> tuple[dict, list[list[str]]]:
        pin = ready_pin()
        commands: list[list[str]] = []
        original_evidence_path = proof.EVIDENCE_PATH
        with tempfile.TemporaryDirectory(prefix="sandra-r1-main-test-") as temp:
            evidence_path = Path(temp) / "receipt.json"
            proof.EVIDENCE_PATH = evidence_path

            def fake_run(args, check=True, timeout=120):
                commands.append(args)
                if args[:3] == ["gh", "attestation", "verify"]:
                    if failure == "attestation":
                        return SimpleNamespace(stdout="", stderr="signature rejected", returncode=1)
                    if failure == "empty attestation":
                        return SimpleNamespace(stdout=json.dumps([]), stderr="", returncode=0)
                    payload = attestation_payload()
                    if failure == "wrong buildSignerURI":
                        payload[0]["verificationResult"]["signature"]["certificate"]["buildSignerURI"] = "https://github.com/biginkc/sandra/.github/workflows/other.yml@refs/heads/main"
                    return SimpleNamespace(stdout=json.dumps(payload), stderr="", returncode=0)
                if args[:2] == ["git", "-C"] and args[2] == str(ROOT) and args[3] == "show":
                    workflow = workflow_fixture()
                    if failure == "workflow":
                        workflow = workflow.replace(f"ref: {EIMG_SOURCE_COMMIT}", "ref: " + "b" * 40)
                    return SimpleNamespace(stdout=workflow, stderr="", returncode=0)
                if args[:2] == ["gh", "api"]:
                    path = args[2]
                    if path.endswith("/artifacts"):
                        return SimpleNamespace(stdout=json.dumps({"artifacts": [{"name": "inbox-electric-image-evidence-756"}]}), stderr="", returncode=0)
                    if path.endswith("/actions/runs/756"):
                        result = run_payload(conclusion="failure" if failure == "evidence" else "success")
                        return SimpleNamespace(stdout=json.dumps(result), stderr="", returncode=0)
                if args[:3] == ["gh", "run", "download"]:
                    output_dir = Path(args[args.index("--dir") + 1])
                    output_dir.mkdir(parents=True, exist_ok=True)
                    (output_dir / "evidence.json").write_text(json.dumps(evidence_payload(pin)), encoding="utf-8")
                    return SimpleNamespace(stdout="", stderr="", returncode=0)
                raise AssertionError(f"unexpected fake command: {args}")

            def fake_docker(*args, **kwargs):
                if "{{index .RepoDigests 0}}" in args:
                    stdout = pin.repository_digest
                elif "{{json .Config.Labels}}" in args:
                    stdout = json.dumps(EIMG_LABELS)
                else:
                    stdout = ""
                return SimpleNamespace(stdout=stdout, stderr="", returncode=0)

            proof.run = fake_run
            proof.docker = fake_docker
            proof.docker_text = lambda *args, **kwargs: "3000"
            proof.load_electric_pin = lambda: pin
            proof.ensure_pinned_image = lambda _pin: (pin.image, False, pin.repository_digest)
            proof.ensure_image = lambda _image: False
            proof.wait_postgres = lambda *_args: None
            proof.wait_active = lambda *_args: (200, '{"status":"active"}') if proof.__name__ == "electric_secret_proof" else {"status_code": 200, "json": {"status": "active"}}
            proof.electric_port = lambda _container: 3000
            proof.psql = lambda *_args: ""
            if proof.__name__ == "electric_tls_proof":
                proof.certs = lambda root: (root / "ca.crt", root / "wrong-ca.crt")
                proof.run_contract = lambda *_args: None
            proof.request = lambda *_args: (200, {}, b"")
            if proof.__name__ == "electric_secret_proof":
                responses = iter([
                    (200, {}, b""),
                    (401, {}, b""),
                    (200, {"electric-offset": "1", "electric-handle": "h"}, b""),
                    (400, {}, b""),
                    (401, {}, b""),
                ])
                proof.request = lambda *_args: next(responses)

            try:
                proof.main()
            except proof.ProofError:
                pass
            status = json.loads(evidence_path.read_text())
            proof.EVIDENCE_PATH = original_evidence_path
            return status, commands

    def test_each_proof_main_never_seals_failed_a2_links(self):
        for proof in (load_tls_proof(), load_secret_proof()):
            with self.subTest(proof=proof.__name__, failure="none"):
                status, commands = self._run_fake_main(proof, None)
                self.assertEqual(status["seal_status"], "SEALED")
                self.assertEqual(status["workflow"]["workflow_source"], "local git show")
                self.assertTrue(any(command[:3] == ["gh", "attestation", "verify"] for command in commands))
            for failure, token in (
                ("attestation", "EIMG_ATTESTATION_FAILED"),
                ("empty attestation", "EIMG_ATTESTATION_IDENTITY_FAILED"),
                ("wrong buildSignerURI", "EIMG_ATTESTATION_IDENTITY_FAILED"),
                ("workflow", "EIMG_WORKFLOW_FAILED"),
                ("evidence", "EIMG_RUN_EVIDENCE_FAILED"),
            ):
                with self.subTest(proof=proof.__name__, failure=failure):
                    status, _ = self._run_fake_main(proof, failure)
                    self.assertNotEqual(status["seal_status"], "SEALED")
                    self.assertIn(token, status["error"])

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
