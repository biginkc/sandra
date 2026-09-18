"""Behavioral tests for the guarded local Realtime bootstrap contract."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import patch



MODULE_PATH = Path(__file__).with_name("realtime-bootstrap.py")
SPEC = importlib.util.spec_from_file_location("realtime_bootstrap", MODULE_PATH)
assert SPEC and SPEC.loader
realtime_bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(realtime_bootstrap)


class RealtimeBootstrapTest(unittest.TestCase):
    def test_migration_state_requires_pinned_version_and_both_new_columns(self) -> None:
        complete = {
            "latest_migration": "20260709120000",
            "columns": ("action_filter", "selected_columns"),
        }
        self.assertTrue(realtime_bootstrap.migration_complete(complete))
        self.assertFalse(
            realtime_bootstrap.migration_complete(
                {"latest_migration": "20260709120000", "columns": ("action_filter",)}
            )
        )
        self.assertFalse(
            realtime_bootstrap.migration_complete(
                {
                    "latest_migration": "20260527120000",
                    "columns": ("action_filter", "selected_columns"),
                }
            )
        )


    def test_runtime_role_accepts_least_privilege_replication_profile(self) -> None:
        realtime_bootstrap.require_runtime_role_minimum(
            {
                "role": {
                    "rolcanlogin": True,
                    "rolreplication": True,
                    "rolsuper": False,
                    "rolcreatedb": False,
                    "rolcreaterole": False,
                    "rolbypassrls": False,
                    "anon_set": True,
                    "authenticated_set": True,
                    "service_role_set": True,
                    "set_log_min_messages": True,
                },
                "schema_migrations_select": True,
                "schema_migrations_write": True,
            }
        )
        sql = realtime_bootstrap.runtime_role_sql()
        self.assertIn("ALTER ROLE supabase_realtime_admin WITH REPLICATION", sql)
        self.assertIn(
            "GRANT authenticated TO supabase_realtime_admin WITH INHERIT FALSE, SET TRUE",
            sql,
        )
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE realtime.schema_migrations TO supabase_realtime_admin",
            sql,
        )
        self.assertIn("GRANT SET ON PARAMETER log_min_messages", sql)
        self.assertNotIn("SUPERUSER", sql.upper())

    def test_broadcast_publication_sql_is_exact_and_does_not_grant_database_create(self) -> None:
        sql = realtime_bootstrap.broadcast_publication_sql()
        self.assertIn(
            "CREATE PUBLICATION supabase_realtime_messages_publication FOR TABLE realtime.messages",
            sql,
        )
        self.assertNotIn("GRANT CREATE ON DATABASE", sql.upper())

    def test_broadcast_publication_catalog_guard_requires_expected_table(self) -> None:
        with patch.object(realtime_bootstrap, "sql_query", return_value="true") as sql_call:
            self.assertTrue(realtime_bootstrap.read_broadcast_publication_state())
        query = sql_call.call_args.args[0]
        self.assertIn("pg_publication_rel", query)
        self.assertIn("pg_partition_tree", query)
        self.assertIn("supabase_realtime_messages_publication", query)
        self.assertIn("c.relname = 'messages'", query)

    def test_cdc_state_requires_publication_slot_and_stream(self) -> None:
        with patch.object(
            realtime_bootstrap,
            "sql_query",
            return_value=json.dumps(
                {
                    "publication_exists": True,
                    "publication_messages": True,
                    "slot_active": True,
                    "streaming": True,
                }
            ),
        ) as sql_call:
            state = realtime_bootstrap.read_cdc_state()
        self.assertEqual(
            state,
            {
                "publication_exists": True,
                "publication_messages": True,
                "slot_active": True,
                "streaming": True,
            },
        )
        query = sql_call.call_args.args[0]
        self.assertIn("pg_replication_slots", query)
        self.assertIn("wal2json", query)
        self.assertIn("realtime_replication_connection", query)
        self.assertIn("public' AND c.relname = 'messages'", query)

    def test_cdc_state_rejects_missing_live_prerequisite(self) -> None:
        with self.assertRaises(realtime_bootstrap.BootstrapError):
            realtime_bootstrap.require_cdc_ready(
                {
                    "publication_exists": True,
                    "publication_messages": True,
                    "slot_active": False,
                    "streaming": True,
                }
            )

    def test_running_image_id_and_cached_manifest_are_authoritative_over_tag(self) -> None:
        container = {
            "Image": realtime_bootstrap.REALTIME_IMAGE_ID,
            "Config": {"Image": "public.ecr.aws/supabase/realtime:v2.129.3"},
        }
        image = {
            "Id": realtime_bootstrap.REALTIME_IMAGE_ID,
            "RepoDigests": [
                "public.ecr.aws/supabase/realtime@" + realtime_bootstrap.REALTIME_IMAGE_ID
            ],
        }
        with patch.object(realtime_bootstrap, "docker_json", return_value=[image]):
            realtime_bootstrap.require_pinned_image(container, name="realtime")

    def test_effective_tenant_user_probe_returns_only_decrypted_username(self) -> None:
        with patch.object(
            realtime_bootstrap,
            "docker",
            return_value=SimpleNamespace(stdout="boot log\nsupabase_realtime_admin\n"),
        ) as docker_call:
            self.assertEqual(
                realtime_bootstrap.read_tenant_runtime_user(),
                "supabase_realtime_admin",
            )
        command = docker_call.call_args.args
        self.assertIn("/app/bin/realtime", command)
        self.assertIn("rpc", command)
        self.assertNotIn("eval", command)
        self.assertNotIn("DB_PASSWORD", " ".join(command))

    def test_rpc_readiness_waits_for_remote_node_after_container_running(self) -> None:
        responses = [
            SimpleNamespace(returncode=1, stdout="", stderr="password=private node unavailable"),
            SimpleNamespace(
                returncode=0,
                stdout=f"{realtime_bootstrap.RPC_READY_MARKER}\n",
                stderr="",
            ),
        ]
        with patch.object(realtime_bootstrap, "docker", side_effect=responses) as docker_call:
            with patch.object(realtime_bootstrap.time, "sleep"):
                realtime_bootstrap.wait_for_rpc_ready("temporary-realtime", timeout=1, interval=0)
        self.assertEqual(docker_call.call_count, 2)
        self.assertEqual(docker_call.call_args.args[:4], ("exec", "temporary-realtime", "/app/bin/realtime", "rpc"))
        self.assertIn("Realtime.Repo.query(\"SELECT 1\", [])", docker_call.call_args.args[-1])

    def test_rpc_readiness_keeps_repo_unavailable_marker_in_diagnostic(self) -> None:
        response = SimpleNamespace(
            returncode=0,
            stdout="realtime_bootstrap_repo_unavailable\n",
            stderr="",
        )
        with patch.object(realtime_bootstrap, "docker", return_value=response):
            ready, detail = realtime_bootstrap.rpc_probe("temporary-realtime")
        self.assertFalse(ready)
        self.assertIn("realtime_bootstrap_repo_unavailable", detail)

    def test_apply_waits_for_runtime_rpc_before_initial_tenant_probe(self) -> None:
        state = {
            "latest_migration": realtime_bootstrap.EXPECTED_MIGRATION,
            "migration_count": 82,
            "columns": realtime_bootstrap.EXPECTED_COLUMNS,
            "role": {
                "rolcanlogin": True,
                "rolreplication": True,
                "rolsuper": False,
                "rolcreatedb": False,
                "rolcreaterole": False,
                "rolbypassrls": False,
                "anon_set": True,
                "authenticated_set": True,
                "service_role_set": True,
                "set_log_min_messages": True,
            },
            "schema_migrations_select": True,
            "schema_migrations_write": True,
        }
        tenant = {"settings_fingerprint": "same", "migrations_ran": 1}
        events: list[str] = []

        with patch.dict(
            realtime_bootstrap.os.environ,
            {"INBOX_RELEASE_ALLOW_RUNTIME_MUTATION": "1"},
            clear=False,
        ), patch.object(realtime_bootstrap, "require_mutation_confirmation"), patch.object(
            realtime_bootstrap, "validate_fixture", return_value={"Image": realtime_bootstrap.REALTIME_IMAGE_ID}
        ), patch.object(realtime_bootstrap, "build_migration_run_args", return_value=[]), patch.object(
            realtime_bootstrap, "read_migration_state", return_value=state
        ), patch.object(realtime_bootstrap, "read_tenant_state", return_value=tenant), patch.object(
            realtime_bootstrap,
            "wait_for_rpc_ready",
            side_effect=lambda container: events.append(f"ready:{container}"),
        ), patch.object(
            realtime_bootstrap,
            "read_tenant_runtime_user",
            side_effect=lambda: events.append("tenant-rpc") or realtime_bootstrap.RUNTIME_ROLE,
        ), patch.object(
            realtime_bootstrap,
            "docker",
            return_value=SimpleNamespace(returncode=1, stdout="", stderr=""),
        ), patch.object(
            realtime_bootstrap,
            "read_broadcast_publication_state",
            return_value=True,
        ), patch.object(
            realtime_bootstrap,
            "wait_for_cdc_ready",
            return_value={
                "publication_exists": True,
                "publication_messages": True,
                "slot_active": True,
                "streaming": True,
            },
        ):
            realtime_bootstrap.apply_bootstrap(Path("/private/realtime.env"))

        self.assertGreaterEqual(len(events), 2)
        self.assertEqual(events[0], f"ready:{realtime_bootstrap.REALTIME_CONTAINER}")
        self.assertEqual(events[1], "tenant-rpc")

    def test_rpc_failure_detail_is_bounded_and_redacted(self) -> None:
        failure = subprocess.CalledProcessError(
            1,
            ["docker", "exec"],
            stderr="remote node unavailable password=private-password token=private-token",
        )
        with patch.object(realtime_bootstrap, "docker", side_effect=failure):
            with self.assertRaises(realtime_bootstrap.BootstrapError) as raised:
                realtime_bootstrap.invoke_tenant_migrations("temporary-realtime")
        self.assertIn("tenant migration RPC failed", str(raised.exception))
        self.assertNotIn("private-password", str(raised.exception))
        self.assertNotIn("private-token", str(raised.exception))

    def test_migration_path_explicitly_invokes_existing_tenant_ledger(self) -> None:
        with patch.object(
            realtime_bootstrap,
            "docker",
            return_value=SimpleNamespace(stdout="started\n"),
        ) as docker_call:
            self.assertEqual(
                realtime_bootstrap.invoke_tenant_migrations("temporary-realtime"),
                "started",
            )
        command = docker_call.call_args.args
        self.assertIn("temporary-realtime", command)
        self.assertIn("rpc", command)
        self.assertNotIn("eval", command)
        expression = command[-1]
        self.assertIn("Realtime.Tenants.Migrations.run_migrations", expression)
        self.assertIn("Realtime.Crypto.encrypt!(\"supabase_admin\")", expression)
        self.assertIn("System.fetch_env!(\"DB_PASSWORD\")", expression)
        self.assertIn("db_password", expression)
        self.assertIn("unexpected status", expression)
        self.assertIn("realtime-dev", expression)

    def test_tenant_catalog_probe_uses_the_installed_public_catalog(self) -> None:
        catalog = {
            "tenant_exists": True,
            "migrations_ran": 29,
            "settings_fingerprint": "fingerprint",
            "settings_has_db_user": True,
        }
        with patch.object(
            realtime_bootstrap,
            "sql_query",
            return_value=json.dumps(catalog),
        ) as sql_call:
            self.assertEqual(realtime_bootstrap.read_tenant_state(), catalog)
        query = sql_call.call_args.args[0]
        self.assertIn("FROM public.tenants", query)
        self.assertIn("FROM public.extensions", query)
        self.assertNotIn("_realtime", query)

    def test_migration_cleanup_attempts_restore_after_remove_failure(self) -> None:
        calls: list[tuple[tuple[str, ...], bool]] = []

        def fake_docker(*args: str, check: bool = True) -> SimpleNamespace:
            calls.append((args, check))
            if args[:2] == ("rm", "-f"):
                raise TimeoutError("simulated Docker cleanup timeout")
            return SimpleNamespace(returncode=0, stdout="")

        with patch.object(realtime_bootstrap, "docker", side_effect=fake_docker):
            with patch.object(realtime_bootstrap, "wait_for_rpc_ready") as wait_for_rpc_ready:
                with self.assertRaises(realtime_bootstrap.BootstrapError):
                    realtime_bootstrap.cleanup_migration_container("temporary-realtime")

        self.assertEqual(calls[0][0][:2], ("rm", "-f"))
        self.assertEqual(calls[1][0], ("start", realtime_bootstrap.REALTIME_CONTAINER))
        self.assertTrue(calls[1][1])
        wait_for_rpc_ready.assert_called_once_with(realtime_bootstrap.REALTIME_CONTAINER)

    def test_apply_migration_branch_runs_ledger_then_repairs_and_restarts(self) -> None:
        incomplete = {
            "latest_migration": "20260527120000",
            "migration_count": 81,
            "columns": ("action_filter",),
        }
        complete = {
            "latest_migration": realtime_bootstrap.EXPECTED_MIGRATION,
            "migration_count": 82,
            "columns": realtime_bootstrap.EXPECTED_COLUMNS,
        }
        tenant = {"settings_fingerprint": "same", "migrations_ran": 1}
        events: list[str] = []
        temp_name = "sandra-inbox-release-realtime-migration-20260917"

        def fake_docker(*args: str, check: bool = True) -> SimpleNamespace:
            if args[:2] == ("inspect", temp_name):
                return SimpleNamespace(returncode=1, stdout="", stderr="")
            events.append("docker:" + " ".join(args[:2]))
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(realtime_bootstrap, "require_mutation_confirmation"), patch.object(
            realtime_bootstrap,
            "validate_fixture",
            return_value={"Image": realtime_bootstrap.REALTIME_IMAGE_ID},
        ), patch.object(
            realtime_bootstrap, "build_migration_run_args", return_value=["migration"]
        ), patch.object(
            realtime_bootstrap,
            "read_migration_state",
            side_effect=[incomplete, complete, complete],
        ), patch.object(
            realtime_bootstrap, "read_tenant_state", side_effect=[tenant, tenant]
        ), patch.object(
            realtime_bootstrap,
            "wait_for_rpc_ready",
            side_effect=lambda container: events.append("rpc:" + container),
        ), patch.object(
            realtime_bootstrap,
            "read_tenant_runtime_user",
            return_value=realtime_bootstrap.RUNTIME_ROLE,
        ), patch.object(
            realtime_bootstrap, "docker", side_effect=fake_docker
        ), patch.object(
            realtime_bootstrap,
            "subprocess",
            SimpleNamespace(run=lambda *args, **kwargs: SimpleNamespace(returncode=0)),
        ), patch.object(
            realtime_bootstrap,
            "apply_runtime_role",
            side_effect=lambda: events.append("role"),
        ), patch.object(
            realtime_bootstrap,
            "invoke_tenant_migrations",
            side_effect=lambda container: events.append("migrate:" + container) or "started",
        ), patch.object(
            realtime_bootstrap,
            "wait_for",
            side_effect=lambda predicate, **kwargs: predicate(),
        ), patch.object(
            realtime_bootstrap,
            "inspect_container",
            return_value={"State": {"Status": "running"}},
        ), patch.object(
            realtime_bootstrap,
            "cleanup_and_repair_runtime",
            side_effect=lambda container: events.append("repair:" + container) or (None, None),
        ), patch.object(
            realtime_bootstrap, "migration_state_advanced", return_value=True
        ), patch.object(
            realtime_bootstrap, "require_runtime_role_minimum"
        ), patch.object(
            realtime_bootstrap, "read_broadcast_publication_state", return_value=True
        ), patch.object(
            realtime_bootstrap,
            "wait_for_cdc_ready",
            return_value={
                "publication_exists": True,
                "publication_messages": True,
                "slot_active": True,
                "streaming": True,
            },
        ):
            result = realtime_bootstrap.apply_bootstrap(Path("/private/realtime.env"))

        self.assertEqual(result["status"], "BOOTSTRAPPED")
        self.assertEqual(result["migration_rpc_status"], "started")
        self.assertIn("migrate:" + temp_name, events)
        self.assertIn("repair:" + temp_name, events)
        self.assertLess(events.index("migrate:" + temp_name), events.index("repair:" + temp_name))

    def test_failed_migration_cleanup_still_repairs_both_runtime_prerequisites(self) -> None:
        events: list[str] = []

        with patch.object(
            realtime_bootstrap,
            "cleanup_migration_container",
            side_effect=RuntimeError("simulated migration cleanup failure"),
        ), patch.object(
            realtime_bootstrap,
            "apply_runtime_role",
            side_effect=lambda: events.append("role"),
        ), patch.object(
            realtime_bootstrap,
            "apply_broadcast_publication",
            side_effect=lambda: events.append("publication"),
        ), patch.object(
            realtime_bootstrap,
            "docker",
            return_value=SimpleNamespace(returncode=0, stdout="", stderr=""),
        ), patch.object(realtime_bootstrap, "wait_for_rpc_ready"):
            cleanup_error, repair_error = realtime_bootstrap.cleanup_and_repair_runtime(
                "temporary-realtime"
            )

        self.assertIsNotNone(cleanup_error)
        self.assertIsNone(repair_error)
        self.assertEqual(events, ["role", "publication"])


    def test_runtime_role_rejects_unsafe_or_incomplete_catalog(self) -> None:
        for key in (
            "rolsuper",
            "rolcreatedb",
            "rolcreaterole",
            "rolbypassrls",
            "anon_set",
            "authenticated_set",
            "service_role_set",
            "rolreplication",
            "set_log_min_messages",
            "schema_migrations_select",
            "schema_migrations_write",
        ):
            with self.subTest(key=key):
                role = {
                    "rolcanlogin": True,
                    "rolreplication": True,
                    "rolsuper": False,
                    "rolcreatedb": False,
                    "rolcreaterole": False,
                    "rolbypassrls": False,
                    "anon_set": True,
                    "authenticated_set": True,
                    "service_role_set": True,
                    "set_log_min_messages": True,
                    "schema_migrations_select": True,
                    "schema_migrations_write": True,
                }
                role[key] = False if key in {
                    "rolreplication",
                    "set_log_min_messages",
                    "schema_migrations_select",
                    "anon_set",
                    "authenticated_set",
                    "service_role_set",
                } else True
                state = {"role": role, "schema_migrations_select": True, "schema_migrations_write": True}
                if key == "schema_migrations_select":
                    state["schema_migrations_select"] = False
                if key == "schema_migrations_write":
                    state["schema_migrations_write"] = False
                with self.assertRaises(realtime_bootstrap.BootstrapError):
                    realtime_bootstrap.require_runtime_role_minimum(state)


    def test_fixture_identity_and_network_guards_are_exact(self) -> None:
        realtime_bootstrap.require_fixture_identity(
            "postgres|sandra-inbox-http-owned-synthetic-20260917"
        )
        with self.assertRaises(realtime_bootstrap.BootstrapError):
            realtime_bootstrap.require_fixture_identity(
                "postgres|sandra-inbox-release-http-owned-20260917"
            )
        realtime_bootstrap.require_owned_network(
            {
                "Labels": {
                    "purpose": realtime_bootstrap.PURPOSE,
                    "owner": realtime_bootstrap.OWNER,
                    "marker": realtime_bootstrap.MARKER,
                }
            }
        )
        with self.assertRaises(realtime_bootstrap.BootstrapError):
            realtime_bootstrap.require_owned_network({"Labels": {"owner": realtime_bootstrap.OWNER}})

    def test_schema_ledger_progress_survives_reset_tenant_metadata(self) -> None:
        before = {
            "migration_count": 78,
            "latest_migration": "20260707120000",
            "migrations_ran": 29,
            "settings_fingerprint": "same",
        }
        after = {
            "migration_count": 82,
            "latest_migration": realtime_bootstrap.EXPECTED_MIGRATION,
            "migrations_ran": 0,
            "settings_fingerprint": "same",
        }
        self.assertTrue(realtime_bootstrap.migration_state_advanced(before, after))
        realtime_bootstrap.require_tenant_settings_unchanged(before, after)
        with self.assertRaises(realtime_bootstrap.BootstrapError):
            realtime_bootstrap.require_tenant_settings_unchanged(
                before,
                {
                    "migration_count": 82,
                    "migrations_ran": 0,
                    "settings_fingerprint": "changed",
                },
            )
        self.assertFalse(
            realtime_bootstrap.migration_state_advanced(
                before,
                {
                    "migration_count": 78,
                    "migrations_ran": 0,
                    "settings_fingerprint": "same",
                },
            )
        )

    def test_read_migration_state_records_authoritative_schema_ledger_count(self) -> None:
        with patch.object(
            realtime_bootstrap,
            "sql_query",
            side_effect=[
                realtime_bootstrap.EXPECTED_MIGRATION,
                "82",
                "action_filter,selected_columns",
                json.dumps(
                    {
                        "rolcanlogin": True,
                        "rolreplication": True,
                        "rolsuper": False,
                        "rolcreatedb": False,
                        "rolcreaterole": False,
                        "rolbypassrls": False,
                        "anon_set": True,
                        "authenticated_set": True,
                        "service_role_set": True,
                        "set_log_min_messages": True,
                    }
                ),
                "t",
                "t",
            ],
        ) as sql_call:
            state = realtime_bootstrap.read_migration_state()
        self.assertEqual(state["migration_count"], 82)
        self.assertTrue(state["schema_migrations_select"])
        self.assertEqual(sql_call.call_count, 6)
        self.assertIn("count(*)::text FROM realtime.schema_migrations", sql_call.call_args_list[1].args[0])


    def test_migration_command_uses_private_env_file_and_digest_without_pull(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "realtime.env"
            env_file.write_text("DB_PASSWORD=private\n")
            env_file.chmod(0o600)
            args = realtime_bootstrap.build_migration_run_args(env_file=env_file)
        self.assertEqual(args[args.index("--network") + 1], realtime_bootstrap.NETWORK)
        self.assertEqual(args[args.index("--env", args.index("--env-file")) + 1], "DB_HOST=db")
        self.assertIn("DB_USER=supabase_admin", args)
        self.assertIn("SEED_SELF_HOST=false", args)
        self.assertIn(realtime_bootstrap.REALTIME_IMAGE_REF, args)
        self.assertNotIn("--pull", args)
        self.assertNotIn("private", " ".join(args))


    def test_migration_env_file_must_not_be_group_or_world_readable(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            env_file = Path(directory) / "realtime.env"
            env_file.write_text("DB_PASSWORD=private\n")
            env_file.chmod(0o644)
            with self.assertRaises(realtime_bootstrap.BootstrapError):
                realtime_bootstrap.build_migration_run_args(env_file=env_file)


if __name__ == "__main__":
    unittest.main()
