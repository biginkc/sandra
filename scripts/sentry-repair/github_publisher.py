"""Controller-only GitHub Issues publisher with marker-based idempotency.

This module is intentionally stdlib-only and separate from repair dispatch.
The only credential accepted by :class:`GitHubClient` is held in memory by
the controller; it is never included in an argv, prompt, persisted payload,
or exception message.  Every create is preceded by an exact marker readback,
and an ambiguous POST is quarantined until a later reconciliation finds the
result.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Mapping

from github import GITHUB_LABELS, github_dry_run, github_payload
from store import RepairStore, StateError


DEFAULT_REPOSITORY = "biginkc/sandra"
DEFAULT_API_BASE_URL = "https://api.github.com"
_REPOSITORY_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
_HTTPS_URL_RE = re.compile(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/issues/[1-9][0-9]*\Z")
_MAX_RESPONSE_BYTES = 2_000_000
_MAX_RETRY_AFTER = 86_400


class GitHubError(RuntimeError):
    """A sanitized, classified GitHub API failure."""

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        kind: str = "api",
        retry_after: int | None = None,
        ambiguous: bool = False,
    ) -> None:
        # Never include response bodies, URLs with credentials, or arbitrary
        # provider messages in an error that can reach controller logs.
        super().__init__(message[:300])
        self.status = status
        self.kind = kind
        self.retry_after = retry_after
        self.ambiguous = ambiguous


class GitHubTransportError(GitHubError):
    """A transport failure; POST failures are potentially ambiguous."""


@dataclass(frozen=True)
class GitHubIssue:
    number: int
    html_url: str
    title: str
    body: str
    labels: tuple[str, ...]
    node_id: str | None = None


@dataclass(frozen=True)
class PublishResult:
    action: str
    dedupe_key: str | None
    github_issue_number: int | None = None
    html_url: str | None = None
    status: str | None = None
    reason: str | None = None
    retry_after: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            key: value
            for key, value in {
                "action": self.action,
                "dedupe_key": self.dedupe_key,
                "github_issue_number": self.github_issue_number,
                "html_url": self.html_url,
                "status": self.status,
                "reason": self.reason,
                "retry_after": self.retry_after,
            }.items()
            if value is not None
        }


def validate_repository(value: str) -> str:
    if not isinstance(value, str) or not _REPOSITORY_RE.fullmatch(value.strip()):
        raise ValueError("repository must be an owner/name pair")
    return value.strip()


def _header(headers: Any, name: str) -> str | None:
    try:
        value = headers.get(name)
    except (AttributeError, TypeError):
        return None
    return str(value).strip() if value is not None else None


def _retry_after(headers: Any) -> int | None:
    text = _header(headers, "Retry-After")
    if text is None:
        return None
    try:
        value = int(text)
    except (TypeError, ValueError):
        return None
    return max(0, min(value, _MAX_RETRY_AFTER))


def _positive_int(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise GitHubError(f"GitHub response field {field} is invalid", kind="malformed")
    return value


def validate_issue_payload(value: Any) -> GitHubIssue:
    """Validate only the fields needed for safe marker/label readback."""

    if not isinstance(value, Mapping):
        raise GitHubError("GitHub issue response must be an object", kind="malformed")
    number = _positive_int(value.get("number"), "number")
    html_url = value.get("html_url")
    title = value.get("title")
    body = value.get("body")
    labels = value.get("labels")
    if not isinstance(html_url, str) or not _HTTPS_URL_RE.fullmatch(html_url):
        raise GitHubError("GitHub issue response URL is invalid", kind="malformed")
    if not isinstance(title, str) or len(title) > 500:
        raise GitHubError("GitHub issue response title is invalid", kind="malformed")
    if not isinstance(body, str) or len(body) > _MAX_RESPONSE_BYTES:
        raise GitHubError("GitHub issue response body is invalid", kind="malformed")
    if not isinstance(labels, list) or len(labels) > 100:
        raise GitHubError("GitHub issue response labels are invalid", kind="malformed")
    if "pull_request" in value:
        raise GitHubError("GitHub readback returned a pull request", kind="malformed")
    names: list[str] = []
    for label in labels:
        if not isinstance(label, Mapping) or not isinstance(label.get("name"), str):
            raise GitHubError("GitHub issue response label is invalid", kind="malformed")
        name = label["name"].strip()
        if not name or len(name) > 100:
            raise GitHubError("GitHub issue response label is invalid", kind="malformed")
        names.append(name)
    node_id = value.get("node_id")
    if node_id is not None and (not isinstance(node_id, str) or len(node_id) > 200):
        raise GitHubError("GitHub issue response node id is invalid", kind="malformed")
    return GitHubIssue(number, html_url, title, body, tuple(names), node_id)


class GitHubClient:
    """Small GitHub REST client with strict response handling.

    ``opener`` is injectable for tests and must have the same shape as
    ``urllib.request.urlopen``.  The client never parses arbitrary provider
    error text, and it caps both request timeouts and response size.
    """

    def __init__(
        self,
        *,
        repository: str = DEFAULT_REPOSITORY,
        token: str | None = None,
        base_url: str = DEFAULT_API_BASE_URL,
        timeout_seconds: int = 20,
        opener: Callable[..., Any] | None = None,
    ) -> None:
        self.repository = validate_repository(repository)
        if timeout_seconds <= 0 or timeout_seconds > 120:
            raise ValueError("GitHub timeout must be between 1 and 120 seconds")
        self.timeout_seconds = timeout_seconds
        self.base_url = base_url.rstrip("/")
        if not self.base_url.startswith(("https://", "http://")):
            raise ValueError("GitHub API base URL must use HTTP(S)")
        self._token = token.strip() if isinstance(token, str) and token.strip() else None
        self._opener = opener or urllib.request.urlopen

    @staticmethod
    def _decode_body(response: Any) -> Any:
        try:
            body = response.read(_MAX_RESPONSE_BYTES + 1)
        except TypeError:
            body = response.read()
        if isinstance(body, bytes) and len(body) > _MAX_RESPONSE_BYTES:
            raise GitHubError("GitHub response exceeded size limit", kind="malformed")
        if isinstance(body, str) and len(body.encode("utf-8")) > _MAX_RESPONSE_BYTES:
            raise GitHubError("GitHub response exceeded size limit", kind="malformed")
        try:
            return json.loads(body.decode("utf-8") if isinstance(body, bytes) else body)
        except (TypeError, ValueError, UnicodeDecodeError) as exc:
            raise GitHubError("GitHub returned invalid JSON", kind="malformed") from exc

    def _request_json(self, method: str, path: str, payload: Mapping[str, Any] | None = None) -> Any:
        if not path.startswith("/") or "?" in path and any(part in path for part in ("#", "\\")):
            raise ValueError("invalid GitHub API path")
        body = None
        headers = {
            "Accept": "application/vnd.github+json",
            "User-Agent": "sandra-sentry-controller/1",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        if payload is not None:
            body = json.dumps(dict(payload), sort_keys=True, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.base_url}{path}", data=body, headers=headers, method=method
        )
        try:
            response = self._opener(request, timeout=self.timeout_seconds)
            status = int(response.getcode()) if hasattr(response, "getcode") else 200
            response_headers = getattr(response, "headers", {})
            if status >= 400:
                # Do not consume or expose the provider's arbitrary body.
                try:
                    response.read(_MAX_RESPONSE_BYTES + 1)
                except TypeError:
                    response.read()
                retry = _retry_after(response_headers)
                kind = "rate_limited" if status == 429 else "forbidden" if status == 403 else "validation" if status == 422 else "api"
                raise GitHubError(
                    f"GitHub API returned HTTP {status}",
                    status=status,
                    kind=kind,
                    retry_after=retry,
                    ambiguous=method == "POST" and status not in {403, 422, 429},
                )
            return self._decode_body(response)
        except GitHubError:
            raise
        except urllib.error.HTTPError as exc:
            status = int(exc.code) if isinstance(exc.code, int) else None
            retry = _retry_after(exc.headers)
            kind = "rate_limited" if status == 429 else "forbidden" if status == 403 else "validation" if status == 422 else "api"
            try:
                exc.close()
            except Exception:
                pass
            raise GitHubError(
                f"GitHub API returned HTTP {status or 'unknown'}",
                status=status,
                kind=kind,
                retry_after=retry,
                ambiguous=method == "POST" and status not in {403, 422, 429},
            ) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # The request path is deliberately omitted from this message; a
            # POST may have reached GitHub before the connection failed.
            raise GitHubTransportError(
                "GitHub request transport failure",
                kind="transport",
                ambiguous=method == "POST",
            ) from exc

    def read_issue(self, number: int) -> GitHubIssue:
        number = _positive_int(number, "issue number")
        issue = validate_issue_payload(
            self._request_json("GET", f"/repos/{self.repository}/issues/{number}")
        )
        expected_url = f"https://github.com/{self.repository}/issues/{number}"
        if issue.html_url != expected_url:
            raise GitHubError("GitHub readback URL does not match repository", kind="malformed")
        return issue

    def find_marker(self, marker: str, required_labels: tuple[str, ...] = GITHUB_LABELS) -> GitHubIssue | None:
        if not isinstance(marker, str) or not marker.startswith("<!-- sentry-sync:v") or len(marker) > 500:
            raise ValueError("invalid Sentry marker")
        query = urllib.parse.urlencode(
            {"q": f"repo:{self.repository} in:body \"{marker}\"", "per_page": "10"}
        )
        result = self._request_json("GET", f"/search/issues?{query}")
        if not isinstance(result, Mapping) or not isinstance(result.get("items"), list):
            raise GitHubError("GitHub search response is invalid", kind="malformed")
        matches: list[GitHubIssue] = []
        for item in result["items"]:
            if not isinstance(item, Mapping):
                raise GitHubError("GitHub search item is invalid", kind="malformed")
            number = item.get("number")
            if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
                raise GitHubError("GitHub search issue number is invalid", kind="malformed")
            issue = self.read_issue(number)
            if marker not in issue.body:
                continue
            if any(label not in issue.labels for label in required_labels):
                continue
            matches.append(issue)
        if len(matches) > 1:
            raise GitHubError("GitHub marker matched multiple issues", kind="collision")
        return matches[0] if matches else None

    def create_issue(self, title: str, body: str, labels: tuple[str, ...] = GITHUB_LABELS) -> GitHubIssue:
        if not isinstance(title, str) or not title or len(title) > 500:
            raise ValueError("GitHub issue title is invalid")
        if not isinstance(body, str) or not body or len(body) > 100_000:
            raise ValueError("GitHub issue body is invalid")
        result = self._request_json(
            "POST",
            f"/repos/{self.repository}/issues",
            {"title": title, "body": body, "labels": list(labels)},
        )
        issue = validate_issue_payload(result)
        expected_url = f"https://github.com/{self.repository}/issues/{issue.number}"
        if issue.html_url != expected_url:
            raise GitHubError("GitHub create URL does not match repository", kind="malformed")
        return issue


def github_dedupe_key(row: Mapping[str, Any], repository: str) -> str:
    repository = validate_repository(repository)
    return (
        f"sentry:{row['organization']}/{row['project']}/{row['environment']}/"
        f"{int(row['issue_number'])}:generation={int(row['generation'])}:repo={repository}"
    )


def enqueue_candidate(
    store: RepairStore,
    *,
    organization: str,
    project: str,
    environment: str,
    issue_number: int,
    repository: str = DEFAULT_REPOSITORY,
    now: float | None = None,
) -> PublishResult:
    """Apply policy gates, then durably enqueue exactly one sanitized job."""

    repository = validate_repository(repository)
    row = store.get_issue(organization, project, environment, issue_number)
    if row is None:
        raise StateError("Sentry issue must be ingested before GitHub publication")
    key = github_dedupe_key(row, repository)
    link = store.get_github_link(organization, project, environment, issue_number)
    existing_job = store.get_github_outbox(key)
    # A pending link created by this controller already has its durable job;
    # repeated scheduler polls must not turn it into a reconciliation or
    # create a second row.  Legacy pending links without a job are safe to
    # adopt as a new create operation.
    if existing_job is not None and existing_job["status"] != "published":
        return PublishResult("already_queued", key, status=str(existing_job["status"]), reason="durable GitHub outbox job exists")
    report = github_dry_run(store, organization, project, environment, issue_number)
    if report.action == "linked":
        return PublishResult("linked", None, reason=report.reason, status="created", html_url=report.existing_url)
    if report.action == "suppress":
        return PublishResult("suppressed", None, reason=report.reason, status="suppressed")
    action = "reconcile" if report.action == "reconcile" and link is not None and link["status"] == "create_unknown" else "create"
    payload = github_payload(row)
    inserted = store.enqueue_github_outbox(
        organization,
        project,
        environment,
        issue_number,
        generation=int(row["generation"]),
        repository=repository,
        dedupe_key=key,
        action=action,
        payload=payload,
        now=now,
    )
    return PublishResult("queued" if inserted else "already_queued", key, status="pending", reason=report.reason)


def publisher_dry_run(
    store: RepairStore,
    *,
    organization: str,
    project: str,
    environment: str,
    issue_number: int,
    repository: str = DEFAULT_REPOSITORY,
) -> dict[str, Any]:
    """Return a read-only publication decision and sanitized body preview."""

    repository = validate_repository(repository)
    row = store.get_issue(organization, project, environment, issue_number)
    if row is None:
        raise StateError("Sentry issue must be ingested before GitHub publication")
    report = github_dry_run(store, organization, project, environment, issue_number)
    key = github_dedupe_key(row, repository)
    existing = store.get_github_outbox(key)
    payload = github_payload(row) if report.action in {"would_create", "reconcile"} else None
    return {
        "action": report.action,
        "reason": report.reason,
        "dedupe_key": key,
        "generation": int(row["generation"]),
        "repository": repository,
        "existing_url": report.existing_url,
        "existing_outbox_status": None if existing is None else existing["status"],
        "body": None if payload is None else payload["body"],
        "labels": None if payload is None else payload["labels"],
    }


class GitHubPublisher:
    """Publish one leased outbox item; never passes credentials to workers."""

    def __init__(self, store: RepairStore, client: GitHubClient, *, owner: str, lease_seconds: int = 120):
        if not isinstance(owner, str) or not owner.strip():
            raise ValueError("publisher owner must be non-empty")
        self.store = store
        self.client = client
        self.owner = owner
        self.lease_seconds = lease_seconds

    def publish_one(self, *, now: float | None = None) -> PublishResult | None:
        row = self.store.claim_github_outbox(owner=self.owner, lease_seconds=self.lease_seconds, now=now)
        if row is None:
            return None
        key = str(row["dedupe_key"])
        post_started = False
        try:
            payload = json.loads(str(row["payload_json"]))
            if not isinstance(payload, Mapping):
                raise GitHubError("stored GitHub payload is invalid", kind="malformed")
            title = payload.get("title")
            body = payload.get("body")
            labels = payload.get("labels")
            marker = payload.get("marker")
            if (
                not isinstance(title, str)
                or not isinstance(body, str)
                or not isinstance(labels, list)
                or not isinstance(marker, str)
                or tuple(labels) != GITHUB_LABELS
            ):
                raise GitHubError("stored GitHub payload failed schema validation", kind="malformed")
            existing = self.client.find_marker(marker, GITHUB_LABELS)
            if existing is not None:
                self.store.complete_github_outbox(
                    key,
                    owner=self.owner,
                    github_issue_number=existing.number,
                    html_url=existing.html_url,
                    node_id=existing.node_id,
                    now=now,
                )
                return PublishResult("reconciled", key, existing.number, existing.html_url, "published")
            if row["action"] == "reconcile":
                self.store.mark_github_create_unknown(
                    key,
                    owner=self.owner,
                    error="marker readback found no matching issue; create remains suppressed",
                    now=now,
                )
                return PublishResult("awaiting_marker", key, status="create_unknown", reason="no exact marker readback")
            post_started = True
            created = self.client.create_issue(title, body, GITHUB_LABELS)
            if marker not in created.body or any(label not in created.labels for label in GITHUB_LABELS):
                self.store.mark_github_create_unknown(
                    key,
                    owner=self.owner,
                    error="create response failed marker or label readback",
                    now=now,
                )
                return PublishResult("create_unknown", key, status="create_unknown", reason="create response failed readback")
            self.store.complete_github_outbox(
                key,
                owner=self.owner,
                github_issue_number=created.number,
                html_url=created.html_url,
                node_id=created.node_id,
                now=now,
            )
            return PublishResult("created", key, created.number, created.html_url, "published")
        except GitHubTransportError as exc:
            if exc.ambiguous or row["action"] == "reconcile":
                self.store.mark_github_create_unknown(key, owner=self.owner, error=str(exc), now=now)
                return PublishResult("create_unknown", key, status="create_unknown", reason="transport result is ambiguous")
            self.store.fail_github_outbox(
                key,
                owner=self.owner,
                error=str(exc),
                retry_after=exc.retry_after,
                now=now,
            )
            return PublishResult("failed", key, status="failed", reason=exc.kind)
        except GitHubError as exc:
            # A 2xx response that is malformed, or a POST whose response is
            # otherwise unusable, may still represent a created issue. Keep
            # it quarantined until marker reconciliation resolves it.
            if exc.ambiguous or (post_started and exc.kind == "malformed"):
                self.store.mark_github_create_unknown(key, owner=self.owner, error=str(exc), now=now)
                return PublishResult("create_unknown", key, status="create_unknown", reason=exc.kind, retry_after=exc.retry_after)
            self.store.fail_github_outbox(
                key,
                owner=self.owner,
                error=str(exc),
                retry_after=exc.retry_after,
                now=now,
            )
            return PublishResult("failed", key, status="failed", reason=exc.kind, retry_after=exc.retry_after)
