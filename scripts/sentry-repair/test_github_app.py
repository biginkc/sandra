from __future__ import annotations

import base64
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

from github_app import (  # noqa: E402
    GitHubAppTokenError,
    GitHubAppTokenProvider,
    _parse_rsa_private_key,
)


class Response:
    def __init__(self, payload, *, status=200):
        self.payload = payload
        self.status = status
        self.headers = {}

    def getcode(self):
        return self.status

    def read(self, amount=None):
        body = json.dumps(self.payload).encode("utf-8")
        return body if amount is None else body[:amount]


def der_length(length: int) -> bytes:
    if length < 128:
        return bytes([length])
    encoded = length.to_bytes((length.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(encoded)]) + encoded


def der(tag: int, value: bytes) -> bytes:
    return bytes([tag]) + der_length(len(value)) + value


def der_integer(value: int) -> bytes:
    encoded = value.to_bytes((value.bit_length() + 7) // 8 or 1, "big")
    if encoded[0] & 0x80:
        encoded = b"\x00" + encoded
    return der(0x02, encoded)


def rsa_pem(*, pkcs8: bool = False) -> str:
    modulus = (1 << 2047) | 1
    pkcs1 = der(
        0x30,
        b"".join(
            [
                der_integer(0),
                der_integer(modulus),
                der_integer(65537),
                der_integer(3),
                der_integer(0),
                der_integer(0),
                der_integer(0),
                der_integer(0),
            ]
        ),
    )
    if pkcs8:
        body = der_integer(0) + der(0x30, der(0x06, bytes.fromhex("2A864886F70D010101")) + der(0x05, b"")) + der(0x04, pkcs1)
        der_bytes = der(0x30, body)
        header = "PRIVATE KEY"
    else:
        der_bytes = pkcs1
        header = "RSA PRIVATE KEY"
    encoded = base64.b64encode(der_bytes).decode("ascii")
    lines = [encoded[index : index + 64] for index in range(0, len(encoded), 64)]
    return "-----BEGIN {0}-----\n{1}\n-----END {0}-----".format(header, "\n".join(lines))


class GitHubAppTokenTests(unittest.TestCase):
    def test_parser_accepts_pkcs1_and_pkcs8_rsa_keys(self):
        for pkcs8 in (False, True):
            modulus, private_exponent = _parse_rsa_private_key(rsa_pem(pkcs8=pkcs8))
            self.assertGreaterEqual(modulus.bit_length(), 2048)
            self.assertEqual(private_exponent, 3)

    def test_provider_caches_and_renews_before_expiry(self):
        responses = iter(
            [
                Response({"token": "installation-token-a", "expires_at": "1970-01-01T00:25:00Z"}),
                Response({"token": "installation-token-b", "expires_at": "1970-01-01T00:40:00Z"}),
            ]
        )
        requests = []

        def opener(request, *, timeout):
            requests.append(request)
            return next(responses)

        provider = GitHubAppTokenProvider(
            app_id=123,
            installation_id=456,
            private_key="test-key",
            opener=opener,
            clock=lambda: 1000.0,
        )
        with patch("github_app._parse_rsa_private_key", return_value=(1 << 2047, 3)), patch(
            "github_app._sign_rs256", return_value=b"signature"
        ):
            self.assertEqual(provider.get_token(now=1000), "installation-token-a")
            self.assertEqual(provider.get_token(now=1100), "installation-token-a")
            self.assertEqual(provider.get_token(now=1400), "installation-token-b")
        self.assertEqual(len(requests), 2)
        self.assertTrue(requests[0].full_url.endswith("/app/installations/456/access_tokens"))
        self.assertEqual(requests[0].method, "POST")
        self.assertTrue(requests[0].headers["Authorization"].startswith("Bearer "))
        payload = json.loads(
            base64.urlsafe_b64decode(
                requests[0].headers["Authorization"].split(".")[1] + "=="
            )
        )
        self.assertEqual(payload["iss"], "123")
        self.assertEqual(payload["iat"], 940)
        self.assertEqual(payload["exp"], 1540)

    def test_invalidate_discards_only_matching_cached_token(self):
        responses = iter(
            [
                Response({"token": "token-a", "expires_at": "1970-01-01T00:25:00Z"}),
                Response({"token": "token-b", "expires_at": "1970-01-01T00:40:00Z"}),
            ]
        )
        provider = GitHubAppTokenProvider(
            app_id=1,
            installation_id=2,
            private_key="test-key",
            opener=lambda request, *, timeout: next(responses),
        )
        with patch("github_app._parse_rsa_private_key", return_value=(1 << 2047, 3)), patch(
            "github_app._sign_rs256", return_value=b"signature"
        ):
            self.assertEqual(provider.get_token(now=1000), "token-a")
            provider.invalidate("different-token")
            self.assertEqual(provider.get_token(now=1001), "token-a")
            provider.invalidate("token-a")
            self.assertEqual(provider.get_token(now=1002), "token-b")

    def test_invalid_token_response_is_safe_and_never_exposes_body(self):
        provider = GitHubAppTokenProvider(
            app_id=1,
            installation_id=2,
            private_key="test-key",
            opener=lambda request, *, timeout: Response(
                {"token": "private-token-value\n", "expires_at": "1970-01-01T00:25:00Z"}
            ),
        )
        with patch("github_app._parse_rsa_private_key", return_value=(1 << 2047, 3)), patch(
            "github_app._sign_rs256", return_value=b"signature"
        ):
            with self.assertRaises(GitHubAppTokenError) as context:
                provider.get_token(now=1000)
        self.assertNotIn("private-token-value", str(context.exception))

    def test_http_rejection_is_classified_without_provider_body(self):
        def opener(request, *, timeout):
            error = urllib.error.HTTPError(request.full_url, 403, "private details", {}, None)
            error.close()
            raise error

        provider = GitHubAppTokenProvider(
            app_id=1,
            installation_id=2,
            private_key="test-key",
            opener=opener,
        )
        with patch("github_app._parse_rsa_private_key", return_value=(1 << 2047, 3)), patch(
            "github_app._sign_rs256", return_value=b"signature"
        ):
            with self.assertRaises(GitHubAppTokenError) as context:
                provider.get_token(now=1000)
        self.assertNotIn("private details", str(context.exception))


if __name__ == "__main__":
    unittest.main()
