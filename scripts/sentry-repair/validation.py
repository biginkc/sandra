"""Strict completion and dispatch record validation."""

from __future__ import annotations

import re
from typing import Any, Mapping


class CompletionError(ValueError):
    """A completion record cannot prove the requested outcome."""


def _require(value: Any, label: str) -> Any:
    if value is None or value == "" or value is False:
        raise CompletionError(f"missing required {label}")
    return value


def _sha(value: Any, label: str) -> str:
    text = str(_require(value, label))
    if not re.fullmatch(r"[0-9a-fA-F]{7,64}", text):
        raise CompletionError(f"{label} must be a git SHA")
    return text


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise CompletionError(f"{label} must be an object")
    return value


def validate_completion_record(
    record: Mapping[str, Any], context: Mapping[str, Any]
) -> None:
    """Require exact evidence fields and cross-check persisted records."""

    if not isinstance(record, Mapping):
        raise CompletionError("completion record must be an object")
    attempt = _mapping(context.get("attempt"), "persisted attempt")
    issue = _mapping(context.get("issue"), "persisted issue")
    if str(record.get("attempt_id")) != str(attempt["attempt_id"]):
        raise CompletionError("record attempt_id does not match persisted attempt")
    if int(record.get("issue_number", 0)) != int(attempt["issue_number"]):
        raise CompletionError("record issue_number does not match persisted attempt")
    if int(record.get("generation", 0)) != int(attempt["generation"]):
        raise CompletionError("record generation does not match persisted attempt")
    if record.get("outcome") != "resolved":
        raise CompletionError("only an explicit resolved outcome can complete an attempt")
    _require(record.get("fencing_token"), "fencing_token")
    if str(record["fencing_token"]) != str(attempt["fencing_token"]):
        raise CompletionError("completion fencing token does not match attempt")

    pr_persisted = _mapping(context.get("pull_request"), "persisted pull request")
    pr = _mapping(record.get("pull_request"), "pull_request")
    if int(pr.get("number", 0)) != int(pr_persisted["number"]) or str(pr.get("url")) != str(pr_persisted["url"]):
        raise CompletionError("completion PR does not match persisted PR")
    head_sha = _sha(pr.get("head_sha"), "pull_request.head_sha")
    if head_sha.lower() != str(pr_persisted["head_sha"]).lower():
        raise CompletionError("completion PR SHA does not match persisted PR SHA")
    ci = _mapping(pr.get("ci_run"), "pull_request.ci_run")
    if str(_require(ci.get("id"), "CI run id")) == "":
        raise CompletionError("CI run id is required")
    if str(ci.get("status", "")).lower() not in {"success", "successful", "passed"}:
        raise CompletionError("CI run must have a successful status")
    if _sha(ci.get("sha"), "pull_request.ci_run.sha").lower() != head_sha.lower():
        raise CompletionError("CI SHA must equal PR head SHA")

    deployment_persisted = _mapping(context.get("deployment"), "persisted deployment")
    deployment = _mapping(record.get("deployment"), "deployment")
    if str(deployment.get("environment")) != str(deployment_persisted["environment"]):
        raise CompletionError("deployment environment does not match persisted deployment")
    if _sha(deployment.get("deployed_sha"), "deployment.deployed_sha").lower() != str(deployment_persisted["deployed_sha"]).lower():
        raise CompletionError("deployed SHA does not match persisted deployment")
    if str(deployment.get("deployed_sha")).lower() != head_sha.lower():
        raise CompletionError("deployed SHA must equal PR head SHA")

    functional = _mapping(record.get("functional_probe"), "functional_probe")
    if str(functional.get("status", "")).lower() not in {"pass", "passed", "success"}:
        raise CompletionError("functional probe must explicitly pass")
    if not str(_require(functional.get("evidence"), "functional_probe.evidence")).strip():
        raise CompletionError("functional probe evidence is required")

    observation = _mapping(record.get("sentry_observation"), "sentry_observation")
    if observation.get("no_regression") is not True:
        raise CompletionError("Sentry observation must explicitly report no_regression=true")
    _require(observation.get("query_window"), "sentry_observation.query_window")
    _require(observation.get("observed_at"), "sentry_observation.observed_at")
    if "functional_probe" not in context.get("verifications", {}):
        raise CompletionError("functional probe evidence was not persisted")
    if "sentry_observation" not in context.get("verifications", {}):
        raise CompletionError("Sentry observation evidence was not persisted")
    persisted_review = _mapping(context.get("review"), "persisted independent review")
    if persisted_review.get("model") != "gpt-6-astra" or persisted_review.get("effort") != "medium":
        raise CompletionError("Astra medium review evidence is required")
    if persisted_review.get("decision") != "approved" or not str(persisted_review.get("evidence", "")).strip():
        raise CompletionError("independent review must be approved with evidence")
    if str(persisted_review.get("session_id")) == str(attempt.get("session_id")):
        raise CompletionError("review session must be independent")


def validate_model_outcome(
    model: str, outcome: Mapping[str, Any]
) -> str:
    """Classify a probe without treating generic failures as model absence."""

    if model != "gpt-5.3-codex-spark":
        raise ValueError("only Spark may be probed for fallback selection")
    status = str(outcome.get("status", "")).lower()
    text = f"{outcome.get('stdout', '')} {outcome.get('stderr', '')}".lower()
    explicit_quota = any(
        phrase in text
        for phrase in (
            "usage limit",
            "quota exhausted",
            "quota exceeded",
            "rate limit exceeded",
            "too many requests",
        )
    )
    if status in {"available", "ok", "success"}:
        return "available"
    if status in {"unavailable", "model_unavailable"} or explicit_quota:
        return "unavailable"
    # Auth, timeout, malformed CLI, and unknown errors must stop; silently
    # switching models could duplicate or bypass a bounded attempt.
    raise CompletionError("Spark probe failed without verified model unavailability")

