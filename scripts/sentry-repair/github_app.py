"""Short-lived GitHub App installation-token provider.

This module intentionally uses only the Python standard library. The App
private key is parsed in memory and used to produce an RS256 JWT; it is never
written to disk, placed in argv, or inherited by a repair worker. Installation
tokens are cached only until their provider expiry and are renewed with a
small safety window.
"""

from __future__ import annotations

import base64
import hashlib
import json
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Mapping


_MAX_TOKEN_LIFETIME_SECONDS = 3600
_DEFAULT_TOKEN_SKEW_SECONDS = 120
_MAX_RESPONSE_BYTES = 1_000_000
_SHA256_DIGEST_INFO_PREFIX = bytes.fromhex(
    "3031300d060960864801650304020105000420"
)


class GitHubAppTokenError(RuntimeError):
    """A safe classification for an unavailable installation token."""


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _der_element(data: bytes, offset: int = 0) -> tuple[int, bytes, int]:
    if offset >= len(data):
        raise GitHubAppTokenError("private key is truncated")
    tag = data[offset]
    offset += 1
    if offset >= len(data):
        raise GitHubAppTokenError("private key length is truncated")
    length_byte = data[offset]
    offset += 1
    if length_byte & 0x80:
        length_size = length_byte & 0x7F
        if length_size == 0 or length_size > 4 or offset + length_size > len(data):
            raise GitHubAppTokenError("private key length is invalid")
        length = int.from_bytes(data[offset : offset + length_size], "big")
        offset += length_size
    else:
        length = length_byte
    end = offset + length
    if end > len(data):
        raise GitHubAppTokenError("private key value is truncated")
    return tag, data[offset:end], end


def _der_integer(value: bytes) -> int:
    if not value or value[0] & 0x80:
        raise GitHubAppTokenError("private key integer is invalid")
    return int.from_bytes(value, "big")


def _rsa_components(der: bytes) -> tuple[int, int]:
    tag, sequence, end = _der_element(der)
    if tag != 0x30 or end != len(der):
        raise GitHubAppTokenError("private key must be a DER sequence")
    elements: list[tuple[int, bytes]] = []
    offset = 0
    while offset < len(sequence):
        tag, value, offset = _der_element(sequence, offset)
        elements.append((tag, value))
    # PKCS#8 PrivateKeyInfo wraps the PKCS#1 RSA sequence in an OCTET STRING.
    if len(elements) >= 3 and elements[0][0] == 0x02 and elements[2][0] == 0x04:
        return _rsa_components(elements[2][1])
    # PKCS#1 RSAPrivateKey: version, modulus, public exponent, private exponent.
    if len(elements) < 4 or any(tag != 0x02 for tag, _ in elements[:4]):
        raise GitHubAppTokenError("private key is not an RSA private key")
    version = _der_integer(elements[0][1])
    if version not in (0, 1):
        raise GitHubAppTokenError("private key version is invalid")
    modulus = _der_integer(elements[1][1])
    private_exponent = _der_integer(elements[3][1])
    if modulus <= 0 or private_exponent <= 0 or modulus.bit_length() < 2048:
        raise GitHubAppTokenError("private key size is too small")
    return modulus, private_exponent


def _parse_rsa_private_key(pem: str) -> tuple[int, int]:
    if not isinstance(pem, str) or not pem.strip():
        raise GitHubAppTokenError("GitHub App private key is required")
    text = pem.strip()
    if "BEGIN ENCRYPTED PRIVATE KEY" in text:
        raise GitHubAppTokenError("encrypted GitHub App private keys are unsupported")
    if "BEGIN RSA PRIVATE KEY" in text:
        begin, end = "BEGIN RSA PRIVATE KEY", "END RSA PRIVATE KEY"
    elif "BEGIN PRIVATE KEY" in text:
        begin, end = "BEGIN PRIVATE KEY", "END PRIVATE KEY"
    else:
        raise GitHubAppTokenError("GitHub App private key PEM header is invalid")
    lines = text.splitlines()
    try:
        start = next(index for index, line in enumerate(lines) if begin in line)
        finish = next(index for index, line in enumerate(lines) if end in line and index > start)
    except StopIteration as exc:
        raise GitHubAppTokenError("GitHub App private key PEM footer is invalid") from exc
    encoded = "".join(line.strip() for line in lines[start + 1 : finish])
    try:
        der = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise GitHubAppTokenError("GitHub App private key encoding is invalid") from exc
    return _rsa_components(der)


def _sign_rs256(signing_input: bytes, modulus: int, private_exponent: int) -> bytes:
    digest_info = _SHA256_DIGEST_INFO_PREFIX + hashlib.sha256(signing_input).digest()
    key_size = (modulus.bit_length() + 7) // 8
    padding_size = key_size - len(digest_info) - 3
    if padding_size < 8:
        raise GitHubAppTokenError("GitHub App private key is invalid")
    encoded_message = b"\x00\x01" + (b"\xff" * padding_size) + b"\x00" + digest_info
    signature = pow(int.from_bytes(encoded_message, "big"), private_exponent, modulus)
    return signature.to_bytes(key_size, "big")


def _timestamp(value: Any) -> float:
    text = str(value or "").strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError) as exc:
        raise GitHubAppTokenError("GitHub installation token expiry is invalid") from exc
    if parsed.tzinfo is None:
        raise GitHubAppTokenError("GitHub installation token expiry lacks timezone")
    return parsed.astimezone(timezone.utc).timestamp()


@dataclass(frozen=True)
class CachedInstallationToken:
    token: str
    expires_at: float


class GitHubAppTokenProvider:
    """Renew a GitHub App installation token inside the controller process."""

    def __init__(
        self,
        *,
        app_id: int,
        installation_id: int,
        private_key: str,
        base_url: str = "https://api.github.com",
        timeout_seconds: int = 20,
        opener: Callable[..., Any] | None = None,
        clock: Callable[[], float] | None = None,
        refresh_skew_seconds: int = _DEFAULT_TOKEN_SKEW_SECONDS,
    ) -> None:
        if isinstance(app_id, bool) or not isinstance(app_id, int) or app_id <= 0:
            raise GitHubAppTokenError("GitHub App id is invalid")
        if isinstance(installation_id, bool) or not isinstance(installation_id, int) or installation_id <= 0:
            raise GitHubAppTokenError("GitHub installation id is invalid")
        if timeout_seconds <= 0 or timeout_seconds > 120:
            raise GitHubAppTokenError("GitHub App token timeout is invalid")
        if refresh_skew_seconds < 0 or refresh_skew_seconds >= _MAX_TOKEN_LIFETIME_SECONDS:
            raise GitHubAppTokenError("GitHub App token refresh skew is invalid")
        if not isinstance(base_url, str) or not base_url.startswith("https://"):
            raise GitHubAppTokenError("GitHub App API URL must use HTTPS")
        self.app_id = app_id
        self.installation_id = installation_id
        self._private_key = private_key
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds
        self._opener = opener or urllib.request.urlopen
        self._clock = clock or time.time
        self.refresh_skew_seconds = refresh_skew_seconds
        self._components: tuple[int, int] | None = None
        self._cached: CachedInstallationToken | None = None
        self._lock = threading.Lock()

    def _jwt(self, now: float) -> str:
        if self._components is None:
            self._components = _parse_rsa_private_key(self._private_key)
        header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
        payload = _b64url(
            json.dumps(
                {"iat": int(now) - 60, "exp": int(now) + 540, "iss": str(self.app_id)},
                separators=(",", ":"),
            ).encode()
        )
        signing_input = f"{header}.{payload}".encode("ascii")
        signature = _sign_rs256(signing_input, *self._components)
        return f"{header}.{payload}.{_b64url(signature)}"

    def _refresh(self, now: float) -> CachedInstallationToken:
        jwt = self._jwt(now)
        request = urllib.request.Request(
            f"{self.base_url}/app/installations/{self.installation_id}/access_tokens",
            data=b"{}",
            headers={
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "User-Agent": "sandra-sentry-controller/1",
                "X-GitHub-Api-Version": "2022-11-28",
                "Authorization": f"Bearer {jwt}",
            },
            method="POST",
        )
        response = None
        try:
            response = self._opener(request, timeout=self.timeout_seconds)
            status = int(response.getcode()) if hasattr(response, "getcode") else 200
            if status >= 400:
                try:
                    response.read(_MAX_RESPONSE_BYTES + 1)
                except TypeError:
                    response.read()
                raise GitHubAppTokenError("GitHub App installation token request was rejected")
            try:
                body = response.read(_MAX_RESPONSE_BYTES + 1)
            except TypeError:
                body = response.read()
        except GitHubAppTokenError:
            raise
        except urllib.error.HTTPError as exc:
            try:
                exc.close()
            except Exception:
                pass
            raise GitHubAppTokenError("GitHub App installation token request was rejected") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise GitHubAppTokenError("GitHub App installation token request failed") from None
        finally:
            close = getattr(response, "close", None)
            if callable(close):
                close()
        if isinstance(body, bytes) and len(body) > _MAX_RESPONSE_BYTES:
            raise GitHubAppTokenError("GitHub App installation token response was too large")
        try:
            payload = json.loads(body.decode("utf-8") if isinstance(body, bytes) else body)
        except (TypeError, ValueError, UnicodeDecodeError) as exc:
            raise GitHubAppTokenError("GitHub App installation token response was invalid") from exc
        if not isinstance(payload, Mapping):
            raise GitHubAppTokenError("GitHub App installation token response was invalid")
        token = payload.get("token")
        if not isinstance(token, str) or not token.strip() or any(character.isspace() for character in token):
            raise GitHubAppTokenError("GitHub App installation token is invalid")
        expires_at = _timestamp(payload.get("expires_at"))
        if expires_at <= now + self.refresh_skew_seconds or expires_at > now + _MAX_TOKEN_LIFETIME_SECONDS + 60:
            raise GitHubAppTokenError("GitHub App installation token expiry is unsafe")
        return CachedInstallationToken(token.strip(), expires_at)

    def get_token(self, now: float | None = None) -> str:
        observed = self._clock() if now is None else float(now)
        with self._lock:
            if self._cached is not None and self._cached.expires_at > observed + self.refresh_skew_seconds:
                return self._cached.token
            self._cached = self._refresh(observed)
            return self._cached.token

    def invalidate(self, token: str | None = None) -> None:
        """Discard a cached token after an authentication rejection.

        The optional token prevents a late response from invalidating a newer
        token that another request already refreshed.  The token value is only
        compared in memory and is never logged or persisted.
        """

        with self._lock:
            if self._cached is None or token is None or self._cached.token == token:
                self._cached = None
