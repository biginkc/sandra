#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("register_restate", HERE / "register-restate-services.py")
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def registry(uri: object) -> dict:
    return {
        "deployments": [{
            "uri": uri,
            "id": "deployment-1",
            "sdk_version": "1.17.0",
            "http_version": "HTTP/1.1",
            "services": [{"name": "InboxMetadataOperation", "revision": 1}],
        }]
    }


class RestateRegistrationTests(unittest.TestCase):
    def test_registry_root_trailing_slash_matches_registered_worker(self):
        match = module.deployment_matches(
            registry("http://127.0.0.1:9080/"),
            "http://127.0.0.1:9080",
            "InboxMetadataOperation",
        )
        self.assertEqual(match["revision"], 1)

    def test_different_host_port_or_path_does_not_match(self):
        expected = "http://127.0.0.1:9080"
        for uri in (
            "http://localhost:9080/",
            "http://127.0.0.1:9081/",
            "http://127.0.0.1:9080/api/",
            "https://127.0.0.1:9080/",
        ):
            self.assertIsNone(module.deployment_matches(registry(uri), expected, "InboxMetadataOperation"), uri)

    def test_non_root_path_is_not_normalized(self):
        self.assertFalse(module.deployment_uri_matches("http://127.0.0.1:9080//", "http://127.0.0.1:9080"))
        self.assertFalse(module.deployment_uri_matches("http://127.0.0.1:9080/?x=1", "http://127.0.0.1:9080"))


if __name__ == "__main__":
    unittest.main()
