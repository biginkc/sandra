"""Strict completion and dispatch record validation."""

from __future__ import annotations

import json
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


def _positive_int(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise CompletionError(f"{label} must be a positive integer")
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise CompletionError(f"{label} must be a positive integer") from exc
    if parsed <= 0:
        raise CompletionError(f"{label} must be a positive integer")
    return parsed


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
    if _positive_int(record.get("issue_number"), "issue_number") != int(attempt["issue_number"]):
        raise CompletionError("record issue_number does not match persisted attempt")
    if _positive_int(record.get("generation"), "generation") != int(attempt["generation"]):
        raise CompletionError("record generation does not match persisted attempt")
    if record.get("outcome") != "resolved":
        raise CompletionError("only an explicit resolved outcome can complete an attempt")
    if attempt.get("mode") != "repair":
        raise CompletionError("only repair attempts can be completed")
    if not str(attempt.get("session_id") or "").strip():
        raise CompletionError("repair attempt has no actual execution session")

    pr_persisted = _mapping(context.get("pull_request"), "persisted pull request")
    pr = _mapping(record.get("pull_request"), "pull_request")
    if int(pr.get("number", 0)) != int(pr_persisted["number"]) or str(pr.get("url")) != str(pr_persisted["url"]):
        raise CompletionError("completion PR does not match persisted PR")
    head_sha = _sha(pr.get("head_sha"), "pull_request.head_sha")
    if head_sha.lower() != str(pr_persisted["head_sha"]).lower():
        raise CompletionError("completion PR SHA does not match persisted PR SHA")
    ci = _mapping(pr.get("ci_run"), "pull_request.ci_run")
    persisted_ci_id = str(_require(pr_persisted.get("ci_run_id"), "persisted CI run id"))
    persisted_ci_status = str(_require(pr_persisted.get("ci_status"), "persisted CI status")).lower()
    persisted_ci_sha = _sha(pr_persisted.get("ci_sha"), "persisted CI SHA")
    if str(_require(ci.get("id"), "CI run id")) != persisted_ci_id:
        raise CompletionError("CI run id must match persisted CI evidence")
    status_aliases = {"success": "success", "successful": "success", "passed": "success"}
    record_ci_status = status_aliases.get(str(ci.get("status", "")).lower())
    persisted_ci_status_normalized = status_aliases.get(persisted_ci_status)
    if record_ci_status is None:
        raise CompletionError("CI run must have a successful status")
    if _sha(ci.get("sha"), "pull_request.ci_run.sha").lower() != head_sha.lower():
        raise CompletionError("CI SHA must equal PR head SHA")
    if persisted_ci_status_normalized is None:
        raise CompletionError("persisted CI status must be successful")
    if persisted_ci_sha.lower() != head_sha.lower():
        raise CompletionError("persisted CI SHA must equal PR head SHA")
    if record_ci_status != persisted_ci_status_normalized:
        raise CompletionError("completion CI status does not match persisted CI status")

    deployment_persisted = _mapping(context.get("deployment"), "persisted deployment")
    if str(deployment_persisted.get("environment")) != str(attempt.get("environment")):
        raise CompletionError("persisted deployment environment does not match attempt environment")
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
    persisted_functional = _mapping(
        context.get("verifications", {}).get("functional_probe"),
        "persisted functional probe",
    )
    functional_aliases = {"pass": "pass", "passed": "pass", "success": "pass"}
    persisted_functional_status = functional_aliases.get(
        str(persisted_functional.get("status", "")).lower()
    )
    record_functional_status = functional_aliases.get(
        str(functional.get("status", "")).lower()
    )
    if persisted_functional_status is None:
        raise CompletionError("persisted functional probe must explicitly pass")
    if record_functional_status != persisted_functional_status:
        raise CompletionError("functional probe status does not match persisted evidence")
    if str(functional.get("evidence")) != str(_require(persisted_functional.get("evidence"), "persisted functional probe evidence")):
        raise CompletionError("functional probe evidence does not match persisted evidence")
    functional_id = functional.get("evidence_id") or functional.get("id")
    persisted_functional_id = persisted_functional.get("evidence_id") or persisted_functional.get("id")
    if str(_require(functional_id, "functional_probe.evidence_id")) != str(_require(persisted_functional_id, "persisted functional probe evidence_id")):
        raise CompletionError("functional probe evidence id does not match persisted evidence")
    if functional.get("observed_at") != persisted_functional.get("observed_at"):
        raise CompletionError("functional probe timestamp does not match persisted evidence")

    observation = _mapping(record.get("sentry_observation"), "sentry_observation")
    if observation.get("no_regression") is not True:
        raise CompletionError("Sentry observation must explicitly report no_regression=true")
    _require(observation.get("query_window"), "sentry_observation.query_window")
    _require(observation.get("observed_at"), "sentry_observation.observed_at")
    persisted_observation = _mapping(
        context.get("verifications", {}).get("sentry_observation"),
        "persisted Sentry observation",
    )
    if persisted_observation.get("no_regression") is not True:
        raise CompletionError("persisted Sentry observation must report no_regression=true")
    if observation.get("query_window") != persisted_observation.get("query_window"):
        raise CompletionError("Sentry query window does not match persisted evidence")
    if observation.get("observed_at") != persisted_observation.get("observed_at"):
        raise CompletionError("Sentry observed_at does not match persisted evidence")
    persisted_review = _mapping(context.get("review"), "persisted independent review")
    if persisted_review.get("model") != "gpt-6-astra" or persisted_review.get("effort") != "medium":
        raise CompletionError("Astra medium review evidence is required")
    if persisted_review.get("decision") != "approved" or not str(persisted_review.get("evidence", "")).strip():
        raise CompletionError("independent review must be approved with evidence")
    if persisted_review.get("source") != "codex_exec" or persisted_review.get("verified") != 1:
        raise CompletionError("review provenance was not verified by the controller")
    if persisted_review.get("result_status") not in {"success", "passed"}:
        raise CompletionError("review execution did not succeed")
    try:
        review_command = json.loads(persisted_review.get("command_json", "[]"))
    except (TypeError, ValueError):
        raise CompletionError("review command provenance is invalid")
    if (
        not isinstance(review_command, list)
        or review_command[:3] != ["codex", "exec", "--model"]
        or "gpt-6-astra" not in review_command
        or 'model_reasoning_effort="medium"' not in review_command
        or not any(
            review_command[index : index + 2] == ["-c", "project_doc_max_bytes=0"]
            for index in range(len(review_command) - 1)
        )
    ):
        raise CompletionError("review command provenance is not an isolated Astra medium review")
    if str(persisted_review.get("session_id")) == str(attempt.get("session_id")):
        raise CompletionError("review session must be independent")
    snapshot_fields = (
        ("reviewed_head_sha", head_sha),
        ("reviewed_ci_run_id", persisted_ci_id),
        ("reviewed_ci_sha", persisted_ci_sha),
        ("reviewed_ci_status", persisted_ci_status),
        ("reviewed_deployed_sha", str(deployment_persisted["deployed_sha"])),
        ("reviewed_functional_evidence_id", str(persisted_functional_id)),
        ("reviewed_functional_observed_at", persisted_functional.get("observed_at")),
        ("reviewed_sentry_query_window", persisted_observation.get("query_window")),
        ("reviewed_sentry_observed_at", persisted_observation.get("observed_at")),
    )
    for field, expected in snapshot_fields:
        actual = persisted_review.get(field)
        if actual is None or str(actual).lower() != str(expected).lower():
            raise CompletionError(f"reviewed evidence snapshot does not match {field}")
    try:
        snapshot = json.loads(persisted_review.get("evidence_snapshot_json", ""))
    except (TypeError, ValueError):
        raise CompletionError("reviewed evidence snapshot is invalid")
    if not isinstance(snapshot, Mapping):
        raise CompletionError("reviewed evidence snapshot is invalid")
    if (
        snapshot.get("pull_request") != dict(pr_persisted)
        or snapshot.get("deployment") != dict(deployment_persisted)
        or snapshot.get("verifications") != dict(context.get("verifications", {}))
    ):
        raise CompletionError("reviewed evidence snapshot no longer matches persisted evidence")


def validate_model_outcome(
    model: str, outcome: Mapping[str, Any]
) -> str:
    """Classify a probe without treating generic failures as model absence."""

    if model != "gpt-5.3-codex-spark":
        raise ValueError("only Spark may be probed for fallback selection")
    status = str(outcome.get("status", "")).lower()
    text = f"{outcome.get('stdout', '')} {outcome.get('stderr', '')}".lower()
    if any(
        phrase in text
        for phrase in (
            "authentication failed",
            "unauthorized",
            "invalid api key",
            "permission denied",
            "auth error",
        )
    ):
        raise CompletionError("Spark probe authentication/permission failure is not model unavailability")
    explicit_quota = any(
        phrase in text
        for phrase in (
            "usage limit",
            "quota exhausted",
            "quota exceeded",
            "model unavailable",
            "model is not available",
            "unknown model",
        )
    )
    if status in {"available", "ok", "success"}:
        return "available"
    if status in {"unavailable", "model_unavailable"} or explicit_quota:
        return "unavailable"
    # Auth, timeout, malformed CLI, and unknown errors must stop; silently
    # switching models could duplicate or bypass a bounded attempt.
    raise CompletionError("Spark probe failed without verified model unavailability")
