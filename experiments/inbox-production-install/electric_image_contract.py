"""Shared, fail-closed contract for the candidate Electric image."""

from __future__ import annotations

from dataclasses import dataclass
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
    r"^https://github\.com/biginkc/sandra/actions/runs/[1-9][0-9]*(?:/attempt/[1-9][0-9]*)?$"
)


class CandidateError(ValueError):
    """The candidate is malformed or is not eligible for a sealed path."""


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


def verify_attestation_json(pin: ElectricImagePin, payload: Any) -> dict[str, str]:
    """Check the cryptographically verified identity and upstream source pin.

    The CLI performs signature verification and owner scoping.  This second
    check constrains the verified certificate to the Sandra main workflow and
    the SLSA dependency to the exact upstream Electric commit.
    """

    if not isinstance(payload, list):
        raise CandidateError("gh attestation verify returned a non-array JSON payload")
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

        source_repository = certificate.get("sourceRepository") or certificate.get("sourceRepositoryUri")
        source_owner = certificate.get("sourceRepositoryOwner")
        san = certificate.get("subjectAlternativeName") or certificate.get("subjectAltName")
        if source_repository not in {"https://github.com/biginkc/sandra", "https://github.com/biginkc/sandra/"}:
            continue
        if source_owner not in {None, "biginkc"}:
            continue
        if not isinstance(san, str) or not re.fullmatch(
            r"https://github\.com/biginkc/sandra/\.github/workflows/[^@]+@refs/heads/main", san
        ):
            continue

        predicate = statement.get("predicate")
        build_definition = predicate.get("buildDefinition") if isinstance(predicate, dict) else None
        dependencies = build_definition.get("resolvedDependencies") if isinstance(build_definition, dict) else None
        if not isinstance(dependencies, list):
            continue
        for dependency in dependencies:
            if not isinstance(dependency, dict):
                continue
            uri = dependency.get("uri")
            digest = dependency.get("digest")
            if (
                isinstance(uri, str)
                and re.fullmatch(r"git\+https://github\.com/electric-sql/electric@[0-9a-f]{40}", uri)
                and isinstance(digest, dict)
                and digest.get("sha1") == pin.source_commit
            ):
                return {
                    "source_commit": pin.source_commit,
                    "source_repository": "biginkc/sandra",
                    "source_ref": "refs/heads/main",
                    "signer_workflow": san,
                }
    raise CandidateError("attestation identity/source commit does not match EIMG-3..5")


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
