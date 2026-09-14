"""Privacy-safe, read-only GitHub issue planning for Sentry intake.

This module deliberately has no network client.  It builds a deterministic
preview from durable Sentry state so operators can validate gates and redaction
before a later, separately reviewed outbox publisher receives GitHub credentials.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Mapping

from store import RepairStore


MARKER_VERSION = 1
GITHUB_LABELS = ("sentry", "sentry-production", "automated-repair")
SAFE_TAG_NAMES = frozenset({"surface", "operation", "kind", "code"})
SAFE_LEVELS = frozenset({"fatal", "error", "warning", "info", "debug"})
SAFE_RELEASE = re.compile(r"[0-9a-fA-F]{7,64}\Z")
SAFE_TIMESTAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})\Z")
SAFE_SOURCE_IDENTIFIER = re.compile(r"[A-Za-z0-9_.:-]{1,80}\Z")


@dataclass(frozen=True)
class GitHubDryRun:
    action: str
    reason: str
    source_key: str
    generation: int
    body: str | None
    existing_url: str | None


def _payload(row: Mapping[str, Any]) -> Mapping[str, Any]:
    try:
        value = json.loads(str(row["payload_json"]))
    except (KeyError, TypeError, ValueError):
        return {}
    return value if isinstance(value, Mapping) else {}


def _safe_count(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = int(str(value))
    except (TypeError, ValueError):
        return None
    return parsed if 0 <= parsed <= 10_000_000 else None


def _safe_release(value: Any) -> str:
    text = str(value or "")
    return text if SAFE_RELEASE.fullmatch(text) else "unknown"


def _safe_timestamp(value: Any) -> str:
    text = str(value or "")
    return text if SAFE_TIMESTAMP.fullmatch(text) else "unknown"


def _safe_level(value: Any) -> str:
    text = str(value or "").lower()
    return text if text in SAFE_LEVELS else "unknown"


def _safe_tags(payload: Mapping[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    raw_tags = payload.get("tags")
    if not isinstance(raw_tags, list):
        return result
    for item in raw_tags:
        if not isinstance(item, Mapping):
            continue
        name = item.get("key", item.get("name"))
        value = item.get("value")
        if name not in SAFE_TAG_NAMES or not isinstance(value, str):
            continue
        clean = value.strip()
        if clean and len(clean) <= 80:
            result[str(name)] = clean
    return result


def _marker(organization: str, project: str, environment: str, issue_number: int, generation: int) -> str:
    return (
        f"<!-- sentry-sync:v{MARKER_VERSION} source={organization}/{project} "
        f"environment={environment} issue_id={issue_number} generation={generation} -->"
    )


def _body(row: Mapping[str, Any]) -> str:
    payload = _payload(row)
    tags = _safe_tags(payload)
    lines = [
        "## Sentry production incident",
        "",
        f"- Sentry numeric issue ID: `{row['issue_number']}`",
        f"- Environment: `{row['environment']}`",
        f"- Release: `{_safe_release(row['release'])}`",
        f"- First seen: `{_safe_timestamp(row['first_seen'])}`",
        f"- Last seen: `{_safe_timestamp(row['last_seen'])}`",
        f"- Level: `{_safe_level(row['level'])}`",
        f"- Controller generation: `{row['generation']}`",
    ]
    for label, value in (("Events", _safe_count(payload.get("count"))), ("Affected users", _safe_count(payload.get("userCount")))):
        if value is not None:
            lines.append(f"- {label}: `{value}`")
    if tags:
        # Tag *values* are supplied by telemetry and can contain identifiers.
        # The dry run names the fields that informed triage without publishing
        # any of their values.
        lines.append("- Allowlisted diagnostic fields present: " + ", ".join(f"`{key}`" for key in sorted(tags)))
    lines.extend([
        "",
        "This record intentionally excludes raw Sentry event data, request content, message content, and user or business identifiers.",
        "",
        _marker(row["organization"], row["project"], row["environment"], int(row["issue_number"]), int(row["generation"])),
    ])
    return "\n".join(lines)


def github_payload(row: Mapping[str, Any]) -> dict[str, Any]:
    """Build the complete, bounded GitHub payload from a stored issue row.

    Sentry titles, culprits, event bodies, tag values, and all other
    telemetry text are intentionally absent.  The publisher persists this
    object in its outbox before contacting GitHub, so the privacy boundary is
    enforced before any credential-bearing code is reached.
    """

    organization = str(row.get("organization") or "")
    project = str(row.get("project") or "")
    environment = str(row.get("environment") or "")
    if not all(SAFE_SOURCE_IDENTIFIER.fullmatch(value) for value in (organization, project, environment)):
        raise ValueError("Sentry source identifiers are invalid")
    issue_number = int(row["issue_number"])
    generation = int(row["generation"])
    marker = _marker(organization, project, environment, issue_number, generation)
    title = f"Sandra Sentry production incident #{issue_number}"
    return {
        "title": title,
        "body": _body(row),
        "labels": list(GITHUB_LABELS),
        "marker": marker,
    }


def github_dry_run(store: RepairStore, organization: str, project: str, environment: str, issue_number: int) -> GitHubDryRun:
    """Report a sanitized proposed action without network or database mutation."""

    row = store.get_issue(organization, project, environment, issue_number)
    if row is None:
        raise ValueError("Sentry issue must be ingested before GitHub planning")
    source_key = f"{organization}/{project}/{environment}/{issue_number}"
    link = store.get_github_link(organization, project, environment, issue_number)
    if link is not None and link["status"] == "created" and link["html_url"]:
        return GitHubDryRun("linked", "durable current-generation link exists", source_key, int(row["generation"]), None, link["html_url"])
    if link is not None:
        return GitHubDryRun("reconcile", f"durable link is {link['status']}; publisher must read back before any create", source_key, int(row["generation"]), None, None)
    if row["status"] == "resolved":
        return GitHubDryRun("suppress", "Sentry issue is resolved", source_key, int(row["generation"]), None, None)
    if environment != "vercel-production":
        return GitHubDryRun("suppress", "non-production environment", source_key, int(row["generation"]), None, None)
    tags = _safe_tags(_payload(row))
    # A route name or one broad tag is not enough to hide a production
    # incident. Both tags are required by the controlled-canary contract.
    if tags.get("kind") == "controlled" and tags.get("surface") == "preview_canary":
        return GitHubDryRun("suppress", "verified controlled canary marker", source_key, int(row["generation"]), None, None)
    return GitHubDryRun("would_create", "unresolved production incident requires operator-approved publisher", source_key, int(row["generation"]), _body(row), None)
