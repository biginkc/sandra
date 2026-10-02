"""Shared, fail-closed contract for the candidate Electric image."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CANDIDATE_PATH = ROOT / "deployment/inbox/candidate.json"
EIMG_REPOSITORY = "ghcr.io/biginkc/inbox-electric"
EIMG_TAG = "1.8.1-0f40420"
EIMG_SOURCE_COMMIT = "0f404200402f918a4b1596bc5c8a53479a435349"
EIMG_ATTESTATION_PLACEHOLDER = "PENDING_EIMG_BUILD"
EIMG_DIGEST_PLACEHOLDER = "PENDING_EIMG_BUILD"
EIMG_WORKFLOW_PATH = ".github/workflows/inbox-electric-image.yml"
EIMG_WORKFLOW_SHA256 = "b1d34496d4875f132c8daf12244af5edcae1a10cf23192f08b0f6489af46febb"
EIMG_SIGNER_WORKFLOW = f"biginkc/sandra/{EIMG_WORKFLOW_PATH}"
EIMG_SOURCE_REF = "refs/heads/main"
EIMG_PREDICATE_TYPE = "https://slsa.dev/provenance/v1"
EIMG_LABELS = {
    "org.opencontainers.image.title": "inbox-electric",
    "org.opencontainers.image.version": "1.8.1",
    "org.opencontainers.image.revision": EIMG_SOURCE_COMMIT,
    "org.opencontainers.image.source": "https://github.com/electric-sql/electric",
    "org.opencontainers.image.licenses": "Apache-2.0",
    "org.opencontainers.image.description": "Unofficial BMH rebuild of Electric sync-service 1.8.1 from upstream source. Not published or endorsed by ElectricSQL.",
}
_IMAGE_PATTERN = re.compile(
    rf"^{re.escape(EIMG_REPOSITORY)}:{re.escape(EIMG_TAG)}@sha256:(?P<digest>[a-f0-9]{{64}}|{re.escape(EIMG_DIGEST_PLACEHOLDER)})$"
)
_ATTESTATION_URL_PATTERN = re.compile(
    r"^https://github\.com/biginkc/sandra/actions/runs/[1-9][0-9]*(?:/attempts/[1-9][0-9]*)?$"
)
_RUN_INVOCATION_PATTERN = re.compile(
    r"^https://github\.com/biginkc/sandra/actions/runs/([1-9][0-9]*)/attempts/[1-9][0-9]*$"
)
_COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")


class CandidateError(ValueError):
    """The candidate or its provenance evidence is not eligible to seal."""


@dataclass(frozen=True)
class ElectricImagePin:
    image: str
    repository_digest: str
    digest: str
    source_commit: str
    attestation: str

    @property
    def pending(self) -> bool:
        return self.digest == EIMG_DIGEST_PLACEHOLDER or self.attestation == EIMG_ATTESTATION_PLACEHOLDER

    @property
    def oci_uri(self) -> str:
        return f"oci://{self.repository_digest}"

    def require_ready(self) -> None:
        if self.pending:
            raise CandidateError(
                "EIMG_BUILD_PENDING: candidate Electric digest and attestation must be replaced before deploy or seal"
            )


def _load_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise CandidateError(f"candidate file is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise CandidateError(f"candidate file is invalid JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise CandidateError("candidate root must be an object")
    return value


def load_electric_pin(path: Path = DEFAULT_CANDIDATE_PATH, *, require_ready: bool = False) -> ElectricImagePin:
    candidate = _load_json(path)
    services = candidate.get("services")
    if not isinstance(services, list):
        raise CandidateError("candidate services must be a list")
    electric = next((service for service in services if isinstance(service, dict) and service.get("name") == "inbox-electric"), None)
    if electric is None:
        raise CandidateError("candidate is missing the inbox-electric service")

    image = electric.get("image")
    if not isinstance(image, str):
        raise CandidateError("inbox-electric image must be a string")
    match = _IMAGE_PATTERN.fullmatch(image)
    if match is None:
        raise CandidateError(f"inbox-electric image does not match EIMG-7: {image!r}")

    source_commit = electric.get("sourceCommit")
    if source_commit != EIMG_SOURCE_COMMIT:
        raise CandidateError("inbox-electric sourceCommit does not match EIMG-3")
    attestation = electric.get("attestation")
    if not isinstance(attestation, str) or not attestation:
        raise CandidateError("inbox-electric attestation is required")
    if attestation != EIMG_ATTESTATION_PLACEHOLDER and not _ATTESTATION_URL_PATTERN.fullmatch(attestation):
        raise CandidateError("inbox-electric attestation must be a Sandra GitHub Actions run URL or the explicit pending placeholder")

    digest = match.group("digest")
    pin = ElectricImagePin(
        image=image,
        repository_digest=f"{EIMG_REPOSITORY}@sha256:{digest}",
        digest=digest,
        source_commit=source_commit,
        attestation=attestation,
    )
    if require_ready:
        pin.require_ready()
    return pin


def _text_field(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def verify_attestation_json(pin: ElectricImagePin, payload: Any) -> dict[str, Any]:
    """Verify the real ``gh attestation verify --format json`` certificate shape.

    The CLI verifies the signature, owner, signer workflow, source ref, and
    runner policy.  This check independently constrains the certificate and
    subject digest.  ``statement.predicate`` is intentionally never read:
    workflow-controlled predicate data is not evidence of the upstream commit.
    """

    if not isinstance(payload, list) or not payload:
        raise CandidateError("EIMG_ATTESTATION_IDENTITY_FAILED: gh attestation verify returned no attestations")

    for item in payload:
        if not isinstance(item, dict):
            continue
        verification = item.get("verificationResult")
        if not isinstance(verification, dict):
            continue
        signature = verification.get("signature")
        certificate = signature.get("certificate") if isinstance(signature, dict) else None
        statement = verification.get("statement")
        if not isinstance(certificate, dict) or not isinstance(statement, dict):
            continue

        issuer = _text_field(certificate.get("issuer"))
        source_repository_uri = _text_field(certificate.get("sourceRepositoryURI"))
        source_repository_ref = _text_field(certificate.get("sourceRepositoryRef"))
        build_signer_uri = _text_field(certificate.get("buildSignerURI"))
        runner_environment = _text_field(certificate.get("runnerEnvironment"))
        workflow_trigger = _text_field(certificate.get("githubWorkflowTrigger"))
        source_repository_digest = _text_field(certificate.get("sourceRepositoryDigest"))
        build_signer_digest = _text_field(certificate.get("buildSignerDigest"))
        run_invocation_uri = _text_field(certificate.get("runInvocationURI"))
        if (
            issuer != "https://token.actions.githubusercontent.com"
            or source_repository_uri != "https://github.com/biginkc/sandra"
            or source_repository_ref != EIMG_SOURCE_REF
            or build_signer_uri != f"https://github.com/{EIMG_SIGNER_WORKFLOW}@{EIMG_SOURCE_REF}"
            or runner_environment != "github-hosted"
            or workflow_trigger != "workflow_dispatch"
            or source_repository_digest is None
            or not _COMMIT_PATTERN.fullmatch(source_repository_digest)
            or build_signer_digest != source_repository_digest
            or run_invocation_uri is None
        ):
            continue

        run_match = _RUN_INVOCATION_PATTERN.fullmatch(run_invocation_uri)
        if run_match is None:
            continue

        if statement.get("predicateType") != EIMG_PREDICATE_TYPE:
            continue
        subjects = statement.get("subject")
        if not isinstance(subjects, list):
            continue
        subject_matches = any(
            isinstance(subject, dict)
            and isinstance(subject.get("digest"), dict)
            and subject["digest"].get("sha256") == pin.digest
            for subject in subjects
        )
        if not subject_matches:
            continue

        return {
            "source_repository_digest": source_repository_digest,
            "source_commit": source_repository_digest,
            "run_id": int(run_match.group(1)),
            "run_invocation_uri": run_invocation_uri,
            "predicate_type": EIMG_PREDICATE_TYPE,
            "subject_digest": pin.digest,
            "certificate": {
                "issuer": issuer,
                "sourceRepositoryURI": source_repository_uri,
                "sourceRepositoryRef": source_repository_ref,
                "buildSignerURI": build_signer_uri,
                "runnerEnvironment": runner_environment,
                "githubWorkflowTrigger": workflow_trigger,
                "sourceRepositoryDigest": source_repository_digest,
                "buildSignerDigest": build_signer_digest,
                "runInvocationURI": run_invocation_uri,
            },
        }

    raise CandidateError("EIMG_ATTESTATION_IDENTITY_FAILED: certificate or subject does not match ELEC-5-A2")


def verify_workflow_text(workflow_text: str | bytes) -> dict[str, str]:
    """Require the exact reviewed workflow bytes at attested commit S."""

    if isinstance(workflow_text, str):
        workflow_bytes = workflow_text.encode("utf-8")
    elif isinstance(workflow_text, bytes):
        workflow_bytes = workflow_text
    else:
        raise CandidateError("EIMG_WORKFLOW_FAILED: workflow contents are not text")
    try:
        workflow_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise CandidateError(f"EIMG_WORKFLOW_FAILED: workflow contents are not valid UTF-8: {exc}") from exc

    actual_sha256 = hashlib.sha256(workflow_bytes).hexdigest()
    if actual_sha256 != EIMG_WORKFLOW_SHA256:
        raise CandidateError(
            "EIMG_WORKFLOW_FAILED: workflow SHA-256 mismatch "
            f"(expected {EIMG_WORKFLOW_SHA256}, actual {actual_sha256}); re-pin requires review"
        )
    return {
        "workflow_path": EIMG_WORKFLOW_PATH,
        "source_commit": EIMG_SOURCE_COMMIT,
        "upstream_commit": EIMG_SOURCE_COMMIT,
        "guard": "reviewed workflow byte hash",
    }


def verify_run_evidence_json(
    pin: ElectricImagePin,
    attestation: dict[str, Any],
    run_payload: Any,
    artifact_payload: Any,
) -> dict[str, Any]:
    """Verify run R and the retained workflow evidence artifact."""

    run_id = attestation.get("run_id")
    source_commit = attestation.get("source_repository_digest")
    if not isinstance(run_id, int) or isinstance(run_id, bool) or not isinstance(source_commit, str):
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: attestation did not provide S and R")
    if not isinstance(run_payload, dict):
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow run response is not an object")
    if run_payload.get("conclusion") != "success":
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow run conclusion is not success")
    if run_payload.get("head_sha") != source_commit:
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow run head_sha does not equal S")
    if run_payload.get("head_branch") != "main":
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow run head_branch is not main")
    if run_payload.get("path") != EIMG_WORKFLOW_PATH:
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow run path is not the pinned workflow")
    if not isinstance(artifact_payload, dict):
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence artifact is absent or invalid")

    expected_artifact_name = f"inbox-electric-image-evidence-{run_id}"
    if artifact_payload.get("name") not in {None, expected_artifact_name}:
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence artifact name does not match R")
    if artifact_payload.get("image") != pin.repository_digest:
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence image does not match the pinned reference")
    if artifact_payload.get("upstream_commit") != EIMG_SOURCE_COMMIT:
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence upstream_commit does not match")
    tag_check = artifact_payload.get("tag_check")
    if not isinstance(tag_check, dict) or tag_check.get("resolved_commit") != EIMG_SOURCE_COMMIT:
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence tag_check.resolved_commit does not match")
    if artifact_payload.get("tag_check_result") != "passed":
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence tag_check_result is not passed")
    if artifact_payload.get("workflow_run_id") != run_id:
        raise CandidateError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence workflow_run_id does not match R")

    return {
        "run": {
            "id": run_id,
            "conclusion": run_payload["conclusion"],
            "head_sha": run_payload["head_sha"],
            "head_branch": run_payload["head_branch"],
            "path": run_payload["path"],
        },
        "artifact_name": expected_artifact_name,
        "artifact": artifact_payload,
    }


def verify_labels_json(payload: Any) -> dict[str, str]:
    if not isinstance(payload, dict):
        raise CandidateError("docker inspect returned invalid OCI labels JSON")
    mismatches = {
        key: {"expected": expected, "actual": payload.get(key)}
        for key, expected in EIMG_LABELS.items()
        if payload.get(key) != expected
    }
    unexpected = sorted(set(payload) - set(EIMG_LABELS))
    if mismatches or unexpected:
        if unexpected:
            mismatches["unexpected"] = unexpected
        raise CandidateError(f"OCI labels do not match EIMG-6: {mismatches}")
    return {key: payload[key] for key in EIMG_LABELS}
