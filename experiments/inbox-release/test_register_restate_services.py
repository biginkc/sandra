#!/usr/bin/env python3
import importlib.util
import os
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

    def test_registration_identity_contains_immutable_image_generation(self):
        digest = "a" * 64
        endpoint = module.versioned_endpoint("http://127.0.0.1:9080", "sha256:" + digest)
        self.assertEqual(endpoint, "http://127.0.0.1:9080/runtime/" + digest)
        self.assertTrue(module.deployment_uri_matches(endpoint + "/", endpoint))
        self.assertFalse(module.deployment_uri_matches(endpoint.replace("a" * 64, "b" * 64), endpoint))
        with self.assertRaises(module.GuardError):
            module.versioned_endpoint("http://127.0.0.1:9080", "sha256:" + "A" * 64)

    def test_local_worker_must_serve_the_image_generation_path(self):
        digest = "d" * 64
        state = {
            "Config": {"Labels": {"purpose": module.PURPOSE, "owner": "release-infra", "marker": module.MARKER}, "Env": [
                "INBOX_ACTION_WORKER_ENABLED=1",
                "INBOX_ACTION_LOCAL_FIXTURE=1",
                f"INBOX_RESTATE_REGISTRATION_PATH=/runtime/{digest}",
            ], "Image": "release:tag"},
            "State": {"Running": True},
            "HostConfig": {"NetworkMode": "host"},
            "Image": "sha256:" + digest,
        }
        original_require = module.require_release_container
        original_image = os.environ.get("INBOX_RELEASE_OPERATION_IMAGE_ID")
        module.require_release_container = lambda name: state
        os.environ["INBOX_RELEASE_OPERATION_IMAGE_ID"] = "sha256:" + digest
        try:
            result = module.check_worker(module.WORKERS["operation"]["name"], module.WORKERS["operation"])
            self.assertTrue(result["endpoint"].endswith("/runtime/" + digest))
            state["Config"]["Env"] = ["INBOX_ACTION_WORKER_ENABLED=1", "INBOX_ACTION_LOCAL_FIXTURE=1"]
            with self.assertRaises(module.GuardError):
                module.check_worker(module.WORKERS["operation"]["name"], module.WORKERS["operation"])
        finally:
            module.require_release_container = original_require
            if original_image is None:
                os.environ.pop("INBOX_RELEASE_OPERATION_IMAGE_ID", None)
            else:
                os.environ["INBOX_RELEASE_OPERATION_IMAGE_ID"] = original_image

    def test_railway_mode_uses_generation_specific_private_hostnames(self):
        self.assertEqual(module.RAILWAY_ADMIN, "http://inbox-restate.railway.internal:9070")
        old_generation = os.environ.get("INBOX_RUNTIME_GENERATION")
        os.environ["INBOX_RUNTIME_GENERATION"] = "e" * 64
        try:
            workers = module.configured_railway_workers()
        finally:
            if old_generation is None:
                os.environ.pop("INBOX_RUNTIME_GENERATION", None)
            else:
                os.environ["INBOX_RUNTIME_GENERATION"] = old_generation
        self.assertEqual(workers["operation"]["hostname"], "inbox-operation-worker-" + "e" * 64 + ".railway.internal")
        self.assertEqual(workers["reply"]["hostname"], "inbox-reply-send-worker-" + "e" * 64 + ".railway.internal")
        self.assertTrue(workers["operation"]["endpoint"].endswith("/runtime/" + "e" * 64))

    def test_railway_generation_guard_refuses_third_deployment(self):
        registry = {"deployments": [
            {"id": "one", "services": [{"name": "InboxMetadataOperation"}]},
            {"id": "two", "services": [{"name": "InboxMetadataOperation"}]},
        ]}
        self.assertEqual(module.service_deployment_ids(registry, "InboxMetadataOperation"), {"one", "two"})
        with self.assertRaises(module.GuardError):
            module.assert_generation_capacity(registry, "InboxMetadataOperation")

    def test_two_generations_remain_registered_and_routable_at_once(self):
        service = "InboxMetadataOperation"
        generation_a, generation_b = "a" * 64, "b" * 64
        endpoint_a = "http://inbox-operation-worker-" + generation_a + ".railway.internal:9080/runtime/" + generation_a
        endpoint_b = "http://inbox-operation-worker-" + generation_b + ".railway.internal:9080/runtime/" + generation_b
        registry = {"deployments": [
            {"uri": endpoint_a + "/", "id": "deployment-a", "sdk_version": "1.17.0", "http_version": "HTTP/1.1", "services": [{"name": service, "revision": 1}]},
            {"uri": endpoint_b + "/", "id": "deployment-b", "sdk_version": "1.17.0", "http_version": "HTTP/1.1", "services": [{"name": service, "revision": 2}]},
        ]}
        self.assertEqual(module.deployment_matches(registry, endpoint_a, service)["revision"], 1)
        self.assertEqual(module.deployment_matches(registry, endpoint_b, service)["revision"], 2)
        self.assertEqual(module.service_deployment_ids(registry, service), {"deployment-a", "deployment-b"})
        with self.assertRaises(module.GuardError):
            module.assert_generation_capacity(registry, service)

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
        old_generation = os.environ.get("INBOX_RUNTIME_GENERATION")
        os.environ["INBOX_RUNTIME_GENERATION"] = "c" * 64
        try:
            receipt = module.run_railway(False)
        finally:
            module.http_request = original_request
            module.http_json = original_json
            if old_generation is None:
                os.environ.pop("INBOX_RUNTIME_GENERATION", None)
            else:
                os.environ["INBOX_RUNTIME_GENERATION"] = old_generation
        self.assertEqual(receipt["status"], "READY_TO_REGISTER")
        self.assertNotIn((module.RAILWAY_ADMIN + "/deployments", "POST"), calls)
        self.assertTrue(all(endpoint["endpoint"].endswith("/runtime/" + "c" * 64) for endpoint in receipt["worker_endpoints"]))
        self.assertTrue(all("-" + "c" * 64 + ".railway.internal:" in endpoint["endpoint"] for endpoint in receipt["worker_endpoints"]))

    def test_railway_requires_version_generation(self):
        old_generation = os.environ.pop("INBOX_RUNTIME_GENERATION", None)
        try:
            with self.assertRaises(module.GuardError):
                module.configured_railway_workers()
        finally:
            if old_generation is not None:
                os.environ["INBOX_RUNTIME_GENERATION"] = old_generation


if __name__ == "__main__":
    unittest.main()
