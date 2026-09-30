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

    def test_railway_mode_uses_fixed_private_hostnames(self):
        self.assertEqual(module.RAILWAY_ADMIN, "http://inbox-restate.railway.internal:9070")
        self.assertEqual(module.RAILWAY_WORKERS["operation"]["endpoint"], "http://inbox-operation-worker.railway.internal:9080")
        self.assertEqual(module.RAILWAY_WORKERS["reply"]["endpoint"], "http://inbox-reply-send-worker.railway.internal:9081")

    def test_railway_generation_guard_refuses_third_deployment(self):
        registry = {"deployments": [
            {"id": "one", "services": [{"name": "InboxMetadataOperation"}]},
            {"id": "two", "services": [{"name": "InboxMetadataOperation"}]},
        ]}
        self.assertEqual(module.service_deployment_ids(registry, "InboxMetadataOperation"), {"one", "two"})
        with self.assertRaises(module.GuardError):
            module.assert_generation_capacity(registry, "InboxMetadataOperation")

    def test_railway_inspection_does_not_post(self):
        registry = {"deployments": []}
        calls = []

        def fake_request(url: str, **kwargs):
            calls.append((url, kwargs.get("method", "GET")))
            if url.endswith("/livez") or url.endswith("/health"):
                return 200, None
            return 200, registry

        original_request = module.http_request
        original_json = module.http_json
        module.http_request = fake_request
        module.http_json = lambda url, **kwargs: fake_request(url, **kwargs)
        try:
            receipt = module.run_railway(False)
        finally:
            module.http_request = original_request
            module.http_json = original_json
        self.assertEqual(receipt["status"], "READY_TO_REGISTER")
        self.assertNotIn((module.RAILWAY_ADMIN + "/deployments", "POST"), calls)


if __name__ == "__main__":
    unittest.main()
