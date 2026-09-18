import importlib.util
import os
from pathlib import Path
import re
from unittest import TestCase
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("fault-recovery-adapter.py")
SPEC = importlib.util.spec_from_file_location("fault_recovery_adapter", MODULE_PATH)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FaultRecoveryProbeTests(TestCase):
    def test_full_runtime_services_are_supervised_after_dependency_loss(self) -> None:
        compose = (MODULE_PATH.parent / "execution-stack-compose.yml").read_text()
        for service in ("restate", "electric", "operation-worker", "reply-send-worker", "projection-worker", "relay"):
            match = re.search(
                rf"^  {re.escape(service)}:\n(?P<body>.*?)(?=^  [a-z-]+:|^volumes:)",
                compose,
                re.MULTILINE | re.DOTALL,
            )
            self.assertIsNotNone(match, service)
            self.assertIn("restart: unless-stopped", match.group("body"), service)

    def test_realtime_probe_includes_fixture_anon_key(self) -> None:
        with patch.dict(os.environ, {"INBOX_HTTP_ANON_KEY": "anon/key+owned"}):
            with patch.object(MODULE.http.client, "HTTPConnection") as connection_factory:
                connection = connection_factory.return_value
                connection.getresponse.return_value.status = 101
                connection.getresponse.return_value.read.return_value = b""

                MODULE.wait_realtime_websocket(timeout=1)

                request = connection.request.call_args
                self.assertIsNotNone(request)
                self.assertIn(
                    "/realtime/v1/websocket?vsn=1.0.0&apikey=anon%2Fkey%2Bowned",
                    request.args[1],
                )

    def test_realtime_probe_remains_compatible_without_anon_key(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(MODULE.http.client, "HTTPConnection") as connection_factory:
                connection = connection_factory.return_value
                connection.getresponse.return_value.status = 101
                connection.getresponse.return_value.read.return_value = b""

                MODULE.wait_realtime_websocket(timeout=1)

                request = connection.request.call_args
                self.assertEqual(request.args[1], "/realtime/v1/websocket?vsn=1.0.0")
