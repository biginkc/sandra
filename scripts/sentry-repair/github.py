"""Privacy-safe, read-only GitHub issue planning for Sentry intake.

This module deliberately has no network client.  It builds a deterministic
preview from durable Sentry state so operators can validate gates and redaction
before a later, separately reviewed outbox publisher receives GitHub credentials.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Mapping

from store import RepairStore


MARKER_VERSION = 1
SAFE_TAG_NAMES = frozenset({"surface", "operation", "kind", "code"})


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
        f"- Release: `{row['release'] or 'unknown'}`",
        f"- First seen: `{row['first_seen'] or 'unknown'}`",
        f"- Last seen: `{row['last_seen'] or 'unknown'}`",
        f"- Level: `{row['level']}`",
        f"- Controller generation: `{row['generation']}`",
    ]
    for label, value in (("Events", _safe_count(payload.get("count"))), ("Affected users", _safe_count(payload.get("userCount")))):
        if value is not None:
            lines.append(f"- {label}: `{value}`")
    if tags:
        lines.append("- Allowlisted diagnostic tags: " + ", ".join(f"`{key}={value}`" for key, value in sorted(tags.items())))
    lines.extend([
        "",
        "This record intentionally excludes raw Sentry event data, request content, message content, and user or business identifiers.",
        "",
        _marker(row["organization"], row["project"], row["environment"], int(row["issue_number"]), int(row["generation"])),
    ])
    return "\n".join(lines)


def github_dry_run(store: RepairStore, organization: str, project: str, environment: str, issue_number: int) -> GitHubDryRun:
    """Report a sanitized proposed action without network or database mutation."""

    row = store.get_issue(organization, project, environment, issue_number)
    if row is None:
        raise ValueError("Sentry issue must be ingested before GitHub planning")
    source_key = f"{organization}/{project}/{environment}/{issue_number}"
    link = store.get_github_link(organization, project, environment, issue_number)
    if link is not None:
        return GitHubDryRun("linked", "durable current-generation link exists", source_key, int(row["generation"]), None, link["html_url"])
    if environment != "vercel-production":
        return GitHubDryRun("suppress", "non-production environment", source_key, int(row["generation"]), None, None)
    tags = _safe_tags(_payload(row))
    if tags.get("kind") == "controlled" or tags.get("surface") == "preview_canary":
        return GitHubDryRun("suppress", "verified controlled canary marker", source_key, int(row["generation"]), None, None)
    return GitHubDryRun("would_create", "unresolved production incident requires operator-approved publisher", source_key, int(row["generation"]), _body(row), None)
