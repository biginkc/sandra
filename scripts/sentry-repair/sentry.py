"""Small stdlib Sentry API client and atomic paginated intake."""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from store import IssueInput, RepairStore


DEFAULT_ORGANIZATION = "bmh-group"
DEFAULT_PROJECT = "sandra"
DEFAULT_ENVIRONMENT = "vercel-production"
DEFAULT_BASE_URL = "https://sentry.io"


class SentryError(RuntimeError):
    """A retrieval or payload validation failure."""


@dataclass(frozen=True)
class SentryConfig:
    organization: str = DEFAULT_ORGANIZATION
    project: str = DEFAULT_PROJECT
    environment: str = DEFAULT_ENVIRONMENT
    base_url: str = DEFAULT_BASE_URL
    timeout_seconds: int = 20


@dataclass(frozen=True)
class SentryPage:
    issues: list[Mapping[str, Any]]
    next_cursor: str | None
    has_next: bool


def numeric_issue_key(value: Any) -> int:
    if isinstance(value, bool):
        raise SentryError("boolean issue ids are not numeric keys")
    text = str(value).strip()
    if not re.fullmatch(r"[1-9][0-9]*", text):
        raise SentryError(f"issue id must be a positive numeric key: {value!r}")
    return int(text)


def parse_next_link(link: str | None) -> tuple[str | None, bool]:
    """Parse Sentry's Link header without trusting any response as commands."""

    if not link:
        return None, False
    for part in link.split(","):
        if 'rel="next"' not in part:
            continue
        cursor_match = re.search(r'cursor="([^"]*)"', part)
        result_match = re.search(r'results="([^"]*)"', part)
        cursor = urllib.parse.unquote(cursor_match.group(1)) if cursor_match else None
        has_next = result_match is None or result_match.group(1).lower() == "true"
        return cursor, has_next and bool(cursor)
    return None, False


class SentryClient:
    def __init__(
        self,
        config: SentryConfig = SentryConfig(),
        *,
        token: str | None = None,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.config = config
        self.token = token
        self.opener = opener or urllib.request.urlopen

    def fetch_page(self, cursor: str | None = None) -> SentryPage:
        query = {
            "environment": self.config.environment,
            "query": "is:unresolved",
            "limit": "100",
        }
        if cursor:
            query["cursor"] = cursor
        path = f"/api/0/projects/{urllib.parse.quote(self.config.organization, safe='')}/{urllib.parse.quote(self.config.project, safe='')}/issues/"
        url = f"{self.config.base_url.rstrip('/')}{path}?{urllib.parse.urlencode(query)}"
        request = urllib.request.Request(
            url,
            headers={
                "Accept": "application/json",
                **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
            },
        )
        try:
            response = self.opener(request, timeout=self.config.timeout_seconds)
            body = response.read()
            headers = response.headers
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise SentryError(f"Sentry retrieval failed: {exc}") from exc
        try:
            payload = json.loads(body.decode("utf-8") if isinstance(body, bytes) else body)
        except (TypeError, ValueError) as exc:
            raise SentryError("Sentry returned invalid JSON") from exc
        if not isinstance(payload, list):
            raise SentryError("Sentry issues payload must be a list")
        next_cursor, has_next = parse_next_link(headers.get("Link"))
        return SentryPage([item for item in payload if isinstance(item, Mapping)], next_cursor, has_next)

    def retrieve_all(self, cursor: str | None = None) -> tuple[list[IssueInput], str | None]:
        """Retrieve every page; no store mutation occurs until the loop succeeds."""

        items: list[IssueInput] = []
        next_cursor = cursor
        while True:
            page = self.fetch_page(next_cursor)
            for raw in page.issues:
                issue_number = numeric_issue_key(raw.get("id"))
                # Only copy bounded evidence fields. Any Sentry text remains
                # untrusted data and is never interpreted as instructions.
                metadata = {
                    key: raw.get(key)
                    for key in ("id", "shortId", "title", "culprit", "level", "status", "release", "firstSeen", "lastSeen", "count", "userCount")
                    if key in raw
                }
                tags = raw.get("tags")
                if isinstance(tags, list):
                    metadata["tags"] = tags[:100]
                items.append(
                    IssueInput(
                        issue_number=issue_number,
                        title=str(raw.get("title", ""))[:500],
                        level=str(raw.get("level", "error"))[:40],
                        release=str(raw["lastRelease"]["version"]) if isinstance(raw.get("lastRelease"), Mapping) and raw["lastRelease"].get("version") else None,
                        event_id=str(raw.get("latestEventID")) if raw.get("latestEventID") else None,
                        first_seen=str(raw.get("firstSeen")) if raw.get("firstSeen") else None,
                        last_seen=str(raw.get("lastSeen")) if raw.get("lastSeen") else None,
                        payload=metadata,
                    )
                )
            if not page.has_next:
                return items, page.next_cursor
            if not page.next_cursor or page.next_cursor == next_cursor:
                raise SentryError("Sentry pagination did not provide a progressing cursor")
            next_cursor = page.next_cursor


def intake_from_sentry(store: RepairStore, client: SentryClient, *, retrieved_at: float | None = None) -> list[dict[str, Any]]:
    config = client.config
    # A terminal cursor is a page position, not a durable polling checkpoint.
    # Start every poll from the current snapshot and let the issue key
    # reconcile overlap. Resuming a terminal cursor can miss newly unresolved
    # issues inserted after the prior snapshot.
    issues, new_cursor = client.retrieve_all(None)
    # ingest_issues has one transaction containing issue updates and cursor
    # advancement; failed retrieval above therefore leaves both untouched.
    return store.ingest_issues(
        config.organization,
        config.project,
        config.environment,
        issues,
        cursor=new_cursor,
        retrieved_at=retrieved_at,
    )
