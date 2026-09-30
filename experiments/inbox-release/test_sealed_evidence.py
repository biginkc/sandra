#!/usr/bin/env python3
"""Mutation controls for sealed Git evidence."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import sealed_evidence as evidence
from sealed_evidence import ROOT, EvidenceError, evaluate, evaluate_deploy, evaluate_migration, J5A, MIGRATION_VERSIONS, CATALOG_SECTIONS


class SealedEvidenceTests(unittest.TestCase):
    def test_real_heavy_manifest_contract(self):
        """Exercise the seven sealed manifest projections; artifacts remain digests only."""
        fixture = Path(__file__).with_name("fixtures") / "real-heavy-manifests-e23922f7.json"
        manifests = json.loads(fixture.read_text())
        self.assertEqual(len(manifests), 7)
        tested_sha = "e23922f72032a04a88a47f844c4f35eacefa815a"
        selected = {}
        rejected = []
        for manifest in manifests:
            directory = f"{ROOT}/{tested_sha}/{manifest['tier']}/{manifest['run_id']}"
            paths = {f"{directory}/manifest.json", *(f"{directory}/{name}" for name in manifest["artifacts"])}
            # Fixture contains real digest claims, without raw artifact bytes. Only
            # the byte hashing boundary is stubbed; all manifest checks run here.
            with patch.object(evidence, "parse_manifest", return_value=manifest), patch.object(
                evidence, "artifact_sha256", side_effect=lambda repo, commit, path: manifest["artifacts"][path.removeprefix(directory + "/")]
            ):
                try:
                    run = evidence.validate_manifest(Path("."), "fixture", directory, paths, tested_sha)
                except EvidenceError as exc:
                    rejected.append((manifest["kind"], manifest["phase"], str(exc)))
                    if manifest["kind"] != "db-contract":
                        raise
                    self.assertIn("invalid collection clean-tree attestation", str(exc))
                    repaired = {**manifest, "clean_tree": {"start": True, "end_excluding_run_dir": True, "excluded_path": directory}}
                    with patch.object(evidence, "parse_manifest", return_value=repaired):
                        run = evidence.validate_manifest(Path("."), "fixture", directory, paths, tested_sha)
                selected[run["key"]] = run
        self.assertEqual([(kind, phase) for kind, phase, _ in rejected], [("db-contract", "pre"), ("db-contract", "post")])
        for key in selected:
            evidence._require(selected, (key,), Path("."))
        self.assertEqual(set(J5A) - set(selected), {
            ("pre-merge", "drift-replay", "n/a", "disposable"),
            ("pre-merge", "browser", "post", "disposable"),
            ("pre-merge", "shared-readonly", "pre", "shared-test"),
        })

    def test_catalog_section_contract_matches_node_checker(self):
        source = Path(__file__).resolve().parents[2]
        sections = subprocess.check_output(
            ["node", "--input-type=module", "-e", "import { CATALOG_SECTIONS } from './scripts/outbox-db-contract/catalog-sections.mjs'; console.log(JSON.stringify(CATALOG_SECTIONS))"],
            cwd=source, text=True,
        )
        self.assertEqual(tuple(json.loads(sections)), CATALOG_SECTIONS)

    def test_real_sealer_output_crosses_python_gate_and_detects_drift(self):
        """Use a real Node seal, then the Git-backed Python manifest and artifact gate."""
        catalog_dir = self.record("catalog", kind="catalog-fingerprint", phase="n/a", target="disposable")
        catalog_commit = self.git("rev-parse", "HEAD")
        platform_dir = self.record("platform", kind="db-contract", phase="pre", target="disposable")
        platform_commit = self.git("rev-parse", "HEAD")
        drift_dir = self.record("drift", kind="drift-replay", phase="n/a", target="disposable", extra={"github_run_id": "333", "github_run_attempt": "1", "lane": "drift-replay", "artifact_name": f"heavy-drift-replay-{self.sha}-333-1", "workflow_path": ".github/workflows/inbox-heavy-verification.yml", "workflow_input_sha": self.sha, "event": "workflow_dispatch", "head_branch": "main"})
        drift_commit = self.git("rev-parse", "HEAD")
        catalog = self.catalog_config()
        drift = json.loads((drift_dir / "drift-record-ncsngxlcyxylaeskiteu.json").read_text())
        observed_catalog = evidence.reconstruct_drift_catalog(catalog, drift)
        platform = self.platform_config()
        catalog_bytes = (catalog_dir / "catalog-pre.json").read_bytes()
        platform_bytes = (platform_dir / "platform-config.json").read_bytes()
        source = Path(__file__).resolve().parents[2]
        plan_contract = json.loads(subprocess.check_output(
            ["node", "--input-type=module", "-e", "import { ROLES, SHAPE_NAMES } from './scripts/outbox-db-contract/plan-contract.mjs'; console.log(JSON.stringify({roles:ROLES,shapes:SHAPE_NAMES}))"],
            cwd=source, text=True,
        ))
        self.assertEqual(tuple(plan_contract["roles"]), evidence.PLAN_ROLES)
        self.assertEqual(tuple(plan_contract["shapes"]), evidence.PLAN_SHAPES)
        plan = {"sha256": "a" * 64, "messages_scan": "Index", "total_cost": 10.5}
        raw = {
            "verdict": "PASS", "target": "shared-readonly", "phase": "pre",
            "plans": {role: {shape: plan for shape in plan_contract["shapes"]} for role in plan_contract["roles"]},
            "tls": {"protocol": "TLSv1.3", "cipher": "TLS_AES_256_GCM_SHA384", "leaf_fingerprint": "AA:" * 31 + "AA", "pinned_ca_fingerprint": "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA", "root_in_peer_chain": False, "upstream_hop_ssl": {"ssl": False, "version": None, "cipher": None}},
            "catalog_indexes": {"messages_pkey": {"relation": "messages", "valid": True}},
            "summary": evidence.hosted_platform_summary(platform["postgrest_major"], platform["postgrest_reason"]), "platform_config": platform, "items": {},
            "comparisons": {
                "catalog": {"verdict": "PASS", "input_sha256": hashlib.sha256(catalog_bytes).hexdigest(), "observed_section_sha256": observed_catalog["section_sha256"], "observed_catalog_sha256": observed_catalog["sha256"], "drift_record_sha256": drift["sha256"]},
                "platform": {"verdict": "PASS", "waived_fields": [], "waiver_reasons": {}, "input_sha256": hashlib.sha256(platform_bytes).hexdigest(), "observed_sha256": platform["sha256"]},
            },
        }
        raw_path = Path(self.temp.name).parent / f"shared-raw-{self.sha}.json"
        raw_path.write_text(json.dumps(raw))
        self.addCleanup(raw_path.unlink, missing_ok=True)
        script = (source / "scripts/inbox-ci/seal-shared-readonly.mjs").as_uri()
        args = {"repo": str(self.repo), "sha": self.sha, "phase": "pre", "output": str(raw_path),
                "catalogRecord": catalog_dir.relative_to(self.repo).as_posix(),
                "platformRecord": platform_dir.relative_to(self.repo).as_posix(),
                "driftRecord": drift_dir.relative_to(self.repo).as_posix(),
                "now": "2026-09-28T12:00:00.000Z"}
        node = f"import {{ sealSharedReadonly }} from {json.dumps(script)}; const a=JSON.parse(process.argv[1]); a.now=new Date(a.now); console.log(sealSharedReadonly(a));"
        directory = subprocess.check_output(["node", "--input-type=module", "-e", node, json.dumps(args)], cwd=source, text=True).strip()
        self.commit("real shared readonly seal")

        def check() -> None:
            commit = self.git("rev-parse", "HEAD")
            paths = {p.relative_to(self.repo).as_posix() for p in (self.repo / directory).iterdir()}
            run = evidence.validate_manifest(self.repo, commit, directory, paths, self.sha)
            selected = {}
            for kind, phase, source_dir, source_commit in (("catalog-fingerprint", "n/a", catalog_dir, catalog_commit), ("db-contract", "pre", platform_dir, platform_commit), ("drift-replay", "n/a", drift_dir, drift_commit)):
                relative = source_dir.relative_to(self.repo).as_posix()
                source_paths = {p.relative_to(self.repo).as_posix() for p in source_dir.rglob("*") if p.is_file()}
                source_run = evidence.validate_manifest(self.repo, source_commit, relative, source_paths, self.sha)
                selected[("pre-merge", kind, phase, "disposable")] = source_run
            evidence._check_shared_readonly(self.repo, run, selected)

        check()
        manifest_path = self.repo / directory / "manifest.json"
        output_path = self.repo / directory / "readonly.json"
        original_manifest = json.loads(manifest_path.read_text())
        original_output = json.loads(output_path.read_text())
        original_raw = raw_path.read_bytes()
        self.assertEqual(original_manifest["waived_fields"], [])
        waived_output = json.loads(json.dumps(original_output))
        waived_majors = {"postgres_major": "17", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "2", "postgrest_reason": "NO_CONNECTION", "postgrest_observed_major": None}
        waived_output["platform_config"] = {**waived_majors, "sha256": evidence.platform_digest(waived_majors)}
        waived_output["summary"] = evidence.hosted_platform_summary(evidence.NOT_VERIFIED, "NO_CONNECTION")
        waived_output["comparisons"]["platform"]["verdict"] = {"postgres_major": "PASS", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "PASS"}
        waived_output["comparisons"]["platform"]["waived_fields"] = ["postgrest_major"]
        waived_output["comparisons"]["platform"]["waiver_reasons"] = {"postgrest_major": "NO_CONNECTION"}
        waived_output["comparisons"]["platform"]["observed_sha256"] = waived_output["platform_config"]["sha256"]
        output_path.write_text(json.dumps(waived_output))
        waived_manifest = json.loads(json.dumps(original_manifest))
        waived_manifest["waived_fields"] = ["postgrest_major"]
        waived_manifest["waiver_reasons"] = {"postgrest_major": "NO_CONNECTION"}
        waived_manifest["artifacts"]["readonly.json"] = hashlib.sha256(output_path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(waived_manifest))
        self.commit("accept PostgREST waiver")
        check()
        raw_array = json.loads(json.dumps(raw))
        raw_array["tls"]["leaf_fingerprint"] = [raw_array["tls"]["leaf_fingerprint"]]
        raw_path.write_text(json.dumps(raw_array))
        bad_args = {**args, "now": "2026-09-28T12:01:00.000Z"}
        rejected_by_sealer = subprocess.run(
            ["node", "--input-type=module", "-e", node, json.dumps(bad_args)],
            cwd=source, capture_output=True, text=True,
        )
        self.assertNotEqual(rejected_by_sealer.returncode, 0)
        self.assertIn("Invalid TLS proof", rejected_by_sealer.stderr)
        raw_path.write_bytes(original_raw)

        sealed_array = json.loads(json.dumps(original_output))
        sealed_array["tls"]["leaf_fingerprint"] = [sealed_array["tls"]["leaf_fingerprint"]]
        output_path.write_text(json.dumps(sealed_array))
        array_manifest = json.loads(json.dumps(original_manifest))
        array_manifest["artifacts"]["readonly.json"] = hashlib.sha256(output_path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(array_manifest))
        self.commit("mutate array fingerprint")
        with self.assertRaisesRegex(EvidenceError, "invalid shared-readonly TLS"):
            check()

        for dropped in ("scripts/outbox-db-contract/connection.mjs", evidence.OPERATOR_LIST):
            with self.subTest(dropped=dropped):
                manifest = json.loads(json.dumps(original_manifest))
                manifest["operator_script_sha256"].pop(dropped)
                manifest_path.write_text(json.dumps(manifest))
                self.commit("mutate operator provenance")
                with self.assertRaisesRegex(EvidenceError, "operator provenance mismatch"):
                    check()
        mutations = {
            "plans": lambda out: out.pop("plans"),
            "plan_shape": lambda out: out["plans"]["member"].pop("null_tail"),
            "tls": lambda out: out.pop("tls"),
            "tls_cipher": lambda out: out["tls"].pop("cipher"),
            "catalog_indexes_sha256": lambda out: out.pop("catalog_indexes_sha256"),
            "catalog_index_digest": lambda out: out.update(catalog_indexes_sha256="bad"),
            "source_output_sha256": lambda out: out.pop("source_output_sha256"),
            "comparisons": lambda out: out["comparisons"].pop("platform"),
            "items": lambda out: out.pop("items"),
        }
        for field, mutate in mutations.items():
            with self.subTest(field=field):
                output = json.loads(json.dumps(original_output))
                mutate(output)
                output_path.write_text(json.dumps(output))
                manifest = json.loads(json.dumps(original_manifest))
                manifest["artifacts"]["readonly.json"] = hashlib.sha256(output_path.read_bytes()).hexdigest()
                manifest_path.write_text(json.dumps(manifest))
                self.commit("mutate sealed output")
                with self.assertRaises(EvidenceError):
                    check()

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Evidence Test")
        (self.repo / "base.txt").write_text("base")
        source = Path(__file__).resolve().parents[2]
        for name in json.loads((source / evidence.OPERATOR_LIST).read_text())["operator_scripts"]:
            target = self.repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((source / name).read_bytes())
        fixture_dir = self.repo / evidence.DRIFT_FIXTURE_ROOT
        fixture_dir.mkdir(parents=True, exist_ok=True)
        fixture_items = self.drift_config()["items"]
        for target_ref in sorted(evidence.KNOWN_TARGET_REFS):
            (fixture_dir / f"{target_ref}.items.json").write_text(json.dumps({"fixture_version": evidence.DRIFT_FIXTURE_VERSION, "items": fixture_items}))
        self.commit("base")
        self.sha = self.git("rev-parse", "HEAD")
        self.base_branch = self.git("branch", "--show-current")

    def git(self, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=self.repo, text=True).strip()

    def commit(self, message: str) -> None:
        self.git("add", "-A")
        self.git("commit", "-qm", message)

    @staticmethod
    def platform_config() -> dict:
        value = {"postgres_major": "17", "postgrest_major": "12", "gotrue_major": "2", "postgrest_reason": None, "postgrest_observed_major": "12"}
        return {**value, "sha256": evidence.platform_digest(value)}

    @staticmethod
    def catalog_config() -> dict:
        names = CATALOG_SECTIONS
        sections = {name: [] for name in names}
        sections["relations"] = [
            {"identity": "auth.users", "owner": "supabase_auth_admin", "columns": [], "indexes": []},
            {"identity": "public.message_threads", "owner": "postgres", "columns": [], "indexes": []},
            {"identity": "public.webhook_events", "owner": "postgres", "columns": [], "indexes": []},
        ]
        return evidence.catalog_digest(sections)

    @staticmethod
    def drift_config() -> dict:
        items = []
        for object_name, name, definition, origin, owner in (
            ("public.message_threads", "ai_responder_debounce_token", "uuid", "unknown", "postgres"),
            ("public.message_threads", "ai_responder_debounce_until", "timestamptz", "unknown", "postgres"),
            ("public.webhook_events", "processing_lease_token", "uuid", "unknown", "postgres"),
        ):
            items.append({"object": object_name, "attribute": "columns", "name": name, "canonical_definition": definition, "definition_sha256": hashlib.sha256(definition.encode()).hexdigest(),
                          "classification": {"class": "column", "nullable": True, "default": None, "attidentity": "", "attgenerated": "", "column_acl": None, "owner": owner},
                          "origin": origin, "approval_sha256": None})
        for name, definition, origin, owner, predicate, expression, approval in (
            ("idx_message_threads_ai_responder_status", "CREATE INDEX idx_message_threads_ai_responder_status ON public.message_threads USING btree (ai_responder_status) WHERE (ai_responder_status IS NOT NULL)", "unknown", "postgres", "(ai_responder_status IS NOT NULL)", False, evidence.DRIFT_APPROVALS["idx_message_threads_ai_responder_status"]),
            ("idx_users_email", "CREATE INDEX idx_users_email ON auth.users USING btree (email)", "platform", "supabase_auth_admin", None, False, None),
            ("idx_users_created_at_desc", "CREATE INDEX idx_users_created_at_desc ON auth.users USING btree (created_at DESC)", "platform", "supabase_auth_admin", None, False, None),
            ("idx_users_last_sign_in_at_desc", "CREATE INDEX idx_users_last_sign_in_at_desc ON auth.users USING btree (last_sign_in_at DESC)", "platform", "supabase_auth_admin", None, False, None),
            ("idx_users_name", "CREATE INDEX idx_users_name ON auth.users USING btree (((raw_user_meta_data ->> 'name'::text))) WHERE ((raw_user_meta_data ->> 'name'::text) IS NOT NULL)", "platform", "supabase_auth_admin", "((raw_user_meta_data ->> 'name'::text) IS NOT NULL)", True, evidence.DRIFT_APPROVALS["idx_users_name"]),
        ):
            items.append({"object": "auth.users" if origin == "platform" else "public.message_threads", "attribute": "indexes", "name": name,
                          "canonical_definition": definition, "definition_sha256": hashlib.sha256(definition.encode()).hexdigest(),
                          "classification": {"class": "index", "unique": False, "primary": False, "constraint": False, "valid": True, "ready": True, "live": True, "predicate": predicate, "expression": expression, "owner": owner},
                          "origin": origin, "approval_sha256": approval})
        payload = {"record_version": 1, "target_ref": "ncsngxlcyxylaeskiteu", "candidate_sha": "0" * 40,
                   "baseline_digest": "", "catalog_format_version": evidence.CATALOG_FORMAT_VERSION, "items": sorted(items, key=lambda item: (item["object"], item["attribute"], item["name"]))}
        payload["baseline_digest"] = evidence.catalog_digest(SealedEvidenceTests.catalog_config()["sections"])["sha256"]
        digest_payload = {key: payload[key] for key in ("record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items")}
        return {**payload, "sha256": hashlib.sha256(json.dumps(digest_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}

    def record(self, name="one", *, sha=None, tier="pre-merge", exit_status=0, completed="2026-09-28T12:00:00Z", observed=None, commit=True, kind=None, phase="pre", target="n/a", verdict=None, extra=None) -> Path:
        sha = sha or self.sha
        if kind == "shared-readonly":
            name = "shared-readonly-" + phase + "-" + completed.replace("Z", ".000Z").replace("-", "").replace(":", "").replace(".", "")
        directory = self.repo / ROOT / sha / tier / name
        directory.mkdir(parents=True)
        artifact = directory / "screenshots" / "O01.png"
        artifact.parent.mkdir()
        artifact.write_bytes(b"screenshot")
        relative = directory.relative_to(self.repo).as_posix()
        manifest = {
            "tested_sha": sha, "tier": tier, "kind": kind or ("app-deploy" if tier != "pre-merge" else "browser"), "phase": phase, "target": target, "verdict": verdict or ("PASS" if exit_status == 0 else "FAIL"), "run_id": name,
            "started_at": "2026-09-28T11:00:00Z", "completed_at": completed,
            "runner_script_sha256": "a" * 64, "fault_proxy_script_sha256": "b" * 64,
            "clean_tree": {"start": True, "end_excluding_run_dir": True, "excluded_path": relative},
            "exit_status": exit_status,
            "artifacts": {"screenshots/O01.png": hashlib.sha256(artifact.read_bytes()).hexdigest()},
        }
        if kind == "catalog-fingerprint":
            artifact2 = directory / "catalog-pre.json"
            artifact2.write_text(json.dumps(self.catalog_config()))
            manifest["artifacts"][artifact2.name] = hashlib.sha256(artifact2.read_bytes()).hexdigest()
            artifact3 = directory / "catalog-post.json"
            artifact3.write_text(json.dumps(self.catalog_config()))
            manifest["artifacts"][artifact3.name] = hashlib.sha256(artifact3.read_bytes()).hexdigest()
            manifest["catalog_fingerprint_post_artifact"] = "catalog-post.json"
        if kind == "db-contract" and phase == "pre":
            artifact2 = directory / "platform-config.json"
            artifact2.write_text(json.dumps(getattr(self, "platform_config_override", self.platform_config())))
            manifest["artifacts"][artifact2.name] = hashlib.sha256(artifact2.read_bytes()).hexdigest()
        if kind == "drift-replay":
            artifact.unlink()
            # Keep replay setup valid when a caller deliberately mutates the
            # catalog fixture to exercise a later gate assertion.
            baseline = SealedEvidenceTests.catalog_config()
            drift = self.drift_config()
            drift["candidate_sha"] = self.sha
            drift["baseline_digest"] = baseline["sha256"]
            digest_payload = {key: drift[key] for key in ("record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items")}
            drift["sha256"] = hashlib.sha256(json.dumps(digest_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
            records = {}
            for target_ref in sorted(evidence.KNOWN_TARGET_REFS):
                record = json.loads(json.dumps(drift))
                record["target_ref"] = target_ref
                payload = {key: record[key] for key in ("record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items")}
                record["sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
                records[target_ref] = record
            files = {
                "catalog-pre.json": baseline,
                "catalog-post.json": baseline,
            }
            for target_ref, record in records.items():
                replay = evidence.reconstruct_drift_catalog(baseline, record)
                files.update({
                    f"drift-record-{target_ref}.json": record,
                    f"catalog-pre-{target_ref}.json": replay,
                    f"catalog-post-{target_ref}.json": replay,
                    f"pre-readonly-{target_ref}.json": {"verdict": "PASS", "phase": "pre"},
                    f"post-readonly-{target_ref}.json": {"verdict": "PASS", "phase": "post"},
                    f"contract-pre-{target_ref}.txt": "PASS\n",
                    f"contract-post-{target_ref}.txt": "PASS\n",
                })
            manifest["artifacts"] = {}
            for filename, value in files.items():
                target = directory / filename
                target.write_text(json.dumps(value) if not isinstance(value, str) else value)
                manifest["artifacts"][filename] = hashlib.sha256(target.read_bytes()).hexdigest()
            manifest["summary"] = {"replayed_items": {ref: len(record["items"]) for ref, record in records.items()}, "drift_record_sha256": {ref: record["sha256"] for ref, record in records.items()}, "definition_sha256": {ref: [item["definition_sha256"] for item in record["items"]] for ref, record in records.items()}, "j5a": evidence.J5A_CATALOG_DRIFT_SUMMARY}
        if kind == "shared-readonly":
            manifest.pop("runner_script_sha256")
            manifest.pop("fault_proxy_script_sha256")
            sealed_time = completed.replace("Z", ".000Z")
            manifest["started_at"] = sealed_time
            manifest["completed_at"] = sealed_time
            manifest["run_id"] = "shared-readonly-" + phase + "-" + sealed_time.replace("-", "").replace(":", "").replace(".", "")
            scripts = json.loads((self.repo / evidence.OPERATOR_LIST).read_text())["operator_scripts"]
            inputs = {}
            for label, source_kind, source_phase, filename in (("catalog_record", "catalog-fingerprint", "n/a", "catalog-pre.json"), ("platform_record", "db-contract", "pre", "platform-config.json"), ("drift_record", "drift-replay", "n/a", "drift-record-ncsngxlcyxylaeskiteu.json")):
                candidates = list((self.repo / ROOT / self.sha / "pre-merge").glob("*/manifest.json"))
                found = next((p for p in candidates if (v := json.loads(p.read_text())).get("kind") == source_kind and v.get("phase") == source_phase), None)
                if found:
                    v = json.loads(found.read_text())
                    inputs[label] = {"directory": found.parent.relative_to(self.repo).as_posix(), "artifact": filename, "sha256": v["artifacts"][filename]}
            manifest.update({"event": "operator", "workflow_path": "", "github_run_id": "", "github_run_attempt": "", "target_binding": {"project_ref": "ncsngxlcyxylaeskiteu", "pooler_user": "postgres.ncsngxlcyxylaeskiteu"}, "operator_script_sha256": {name: hashlib.sha256((self.repo / name).read_bytes()).hexdigest() for name in scripts}, "inputs": inputs, "waived_fields": [], "waiver_reasons": {}, "items": {}})
            if len(inputs) == 3:
                platform_data = self.platform_config()
                catalog_data = json.loads(inputs["catalog_record"]["directory"] and (self.repo / inputs["catalog_record"]["directory"] / "catalog-pre.json").read_text())
                drift_data = json.loads((self.repo / inputs["drift_record"]["directory"] / "drift-record-ncsngxlcyxylaeskiteu.json").read_text())
                try:
                    observed_catalog = evidence.reconstruct_drift_catalog(catalog_data, drift_data)
                except EvidenceError:
                    observed_catalog = catalog_data
                plan = {"sha256": "a" * 64, "messages_scan": "Seq Scan", "total_cost": 10}
                output = {"verdict": "PASS", "target": "shared-test", "phase": phase, "source_output_sha256": "a" * 64,
                          "plans": {role: {shape: plan for shape in evidence.PLAN_SHAPES} for role in evidence.PLAN_ROLES},
                          "tls": {"protocol": "TLSv1.3", "cipher": "fixture", "leaf_fingerprint": "AA:" * 31 + "AA", "pinned_ca_fingerprint": "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA", "root_in_peer_chain": False, "upstream_hop_ssl": None}, "catalog_indexes_sha256": "a" * 64,
                          "summary": evidence.hosted_platform_summary(platform_data.get("postgrest_major"), platform_data.get("postgrest_reason")), "platform_config": platform_data,
                          "comparisons": {"catalog": {"verdict": "PASS", "input_sha256": inputs["catalog_record"]["sha256"], "observed_section_sha256": observed_catalog["section_sha256"], "observed_catalog_sha256": observed_catalog["sha256"], "drift_record_sha256": drift_data["sha256"]}, "platform": {"verdict": "PASS", "waived_fields": [], "waiver_reasons": {}, "input_sha256": inputs["platform_record"]["sha256"], "observed_sha256": platform_data["sha256"]}}, "items": {}}
                artifact.unlink()
                manifest["artifacts"] = {"readonly.json": hashlib.sha256(json.dumps(output).encode()).hexdigest()}
                (directory / "readonly.json").write_text(json.dumps(output))
        if extra:
            manifest.update(extra)
        if kind == "shared-readonly" and hasattr(self, "shared_mutation"):
            self.shared_mutation(manifest, directory)
        if observed is not None:
            manifest["observed_deployment"] = observed
        (directory / "manifest.json").write_text(json.dumps(manifest))
        if commit:
            self.commit(name)
        return directory

    def assert_fails(self, phrase: str) -> None:
        with self.assertRaises(EvidenceError) as caught:
            evaluate(self.repo, self.sha, "pre-merge")
        self.assertIn(phrase, str(caught.exception))

    def tamper_manifest(self, old: str, new: str) -> None:
        directory = self.record(commit=False)
        path = directory / "manifest.json"
        raw = path.read_text()
        self.assertIn(old, raw)
        path.write_text(raw.replace(old, new, 1))
        self.commit("tampered manifest")

    def test_duplicate_exit_status_rejected(self) -> None:
        self.tamper_manifest('"exit_status": 0', '"exit_status": 1, "exit_status": 0')
        self.assert_fails("duplicate JSON key: exit_status")

    def test_duplicate_identity_fields_rejected(self) -> None:
        for field, bad in (("tested_sha", "0" * 40), ("tier", "test-env"), ("run_id", "other")):
            with self.subTest(field=field):
                # Each field needs a fresh repository because the record is sealed.
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    value = {"tested_sha": case.sha, "tier": "pre-merge", "run_id": "one"}[field]
                    case.tamper_manifest(json.dumps(field) + ": " + json.dumps(value),
                                         json.dumps(field) + ": " + json.dumps(bad) + ", " + json.dumps(field) + ": " + json.dumps(value))
                    case.assert_fails("duplicate JSON key: " + field)
                finally:
                    case.doCleanups()

    def test_duplicate_artifact_path_rejected(self) -> None:
        good = hashlib.sha256(b"screenshot").hexdigest()
        old = json.dumps("screenshots/O01.png") + ": " + json.dumps(good)
        self.tamper_manifest(old, json.dumps("screenshots/O01.png") + ": " + json.dumps("0" * 64) + ", " + old)
        self.assert_fails("duplicate JSON key: screenshots/O01.png")

    def test_nested_duplicate_artifact_object_key_rejected(self) -> None:
        self.tamper_manifest('"artifacts": {',
                             '"artifact_details": [{"artifact": {"path": "wrong", "path": "screenshots/O01.png"}}], "artifacts": {')
        self.assert_fails("duplicate JSON key: path")

    def test_invalid_artifact_paths_rejected(self) -> None:
        for path in ("/screenshots/O01.png", "C:/screenshots/O01.png", "../screenshots/O01.png",
                     "screenshots/../O01.png", "screenshots\\O01.png", "screenshots//O01.png",
                     "screenshots/./O01.png", "screenshots/a..b.png"):
            with self.subTest(path=path):
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    case.tamper_manifest('"screenshots/O01.png":', json.dumps(path) + ":")
                    case.assert_fails("invalid artifact entry")
                finally:
                    case.doCleanups()

    def test_valid_sealed_record(self) -> None:
        self.record()
        self.assertEqual(evaluate(self.repo, self.sha, "pre-merge")["status"], "PASS")

    def test_relative_symlink_artifact_rejected(self) -> None:
        self.assert_symlink_artifact_rejected("../../../base.txt")

    def test_absolute_symlink_artifact_rejected(self) -> None:
        self.assert_symlink_artifact_rejected("/etc/hosts")

    def assert_symlink_artifact_rejected(self, target: str) -> None:
        directory = self.record(commit=False)
        artifact = directory / "screenshots/O01.png"
        artifact.unlink()
        artifact.symlink_to(target)
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"]["screenshots/O01.png"] = hashlib.sha256(target.encode()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        self.commit("symlink artifact")
        self.assert_fails("non-regular evidence entry")

    def test_gitlink_artifact_rejected(self) -> None:
        directory = self.record(commit=False)
        artifact = directory / "screenshots/O01.png"
        artifact.unlink()
        self.git("add", "-A")
        path = artifact.relative_to(self.repo).as_posix()
        self.git("update-index", "--add", "--cacheinfo", f"160000,{self.sha},{path}")
        self.git("commit", "-qm", "gitlink artifact")
        self.git("reset", "--hard", "HEAD")
        self.assert_fails("non-regular evidence entry")

    def test_dirty_tree_at_evaluation(self) -> None:
        self.record()
        (self.repo / "base.txt").write_text("dirty")
        self.assert_fails("fully clean")

    def test_dirty_index_at_evaluation(self) -> None:
        self.record()
        (self.repo / "base.txt").write_text("staged")
        self.git("add", "base.txt")
        self.assert_fails("fully clean")

    def test_uncommitted_record(self) -> None:
        self.record(commit=False)
        self.assert_fails("fully clean")

    def test_substituted_screenshot(self) -> None:
        directory = self.record(commit=False)
        (directory / "screenshots/O01.png").write_bytes(b"substituted")
        self.commit("bad screenshot")
        self.assert_fails("artifact hash mismatch")

    def test_rewritten_record_later(self) -> None:
        directory = self.record()
        (directory / "screenshots/O01.png").write_bytes(b"rewrite")
        self.commit("rewrite")
        self.assert_fails("non-addition")

    def test_artifact_and_manifest_replaced_together(self) -> None:
        directory = self.record()
        artifact = directory / "screenshots/O01.png"
        artifact.write_bytes(b"rewrite")
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"]["screenshots/O01.png"] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        self.commit("rewrite both")
        self.assert_fails("non-addition")

    def test_non_evidence_path_in_commit(self) -> None:
        self.record(commit=False)
        (self.repo / "base.txt").write_text("changed")
        self.commit("mixed")
        self.assert_fails("non-evidence path")

    def test_merge_commit(self) -> None:
        self.record("one")
        self.git("checkout", "-qb", "other", self.sha)
        self.record("other")
        self.git("checkout", "-q", self.base_branch)
        self.git("merge", "--no-ff", "-qm", "merge", "other")
        self.assert_fails("merge/root")

    def test_wrong_sha_directory(self) -> None:
        self.record(sha="c" * 40)
        self.assert_fails("wrong SHA")

    def test_latest_fail_masks_older_pass(self) -> None:
        self.record("one")
        self.record("two", exit_status=1, completed="2026-09-28T13:00:00Z")
        self.assert_fails("latest required check failed")

    def test_incomplete_run(self) -> None:
        self.record(completed=None)
        self.assert_fails("completed_at")

    def test_non_monotonic_completion(self) -> None:
        self.record("one", completed="2026-09-28T13:00:00Z")
        self.record("two", completed="2026-09-28T12:00:00Z")
        self.assert_fails("non-monotonic")

    def test_addition_inside_sealed_run(self) -> None:
        directory = self.record()
        (directory / "later.log").write_text("late")
        self.commit("late addition")
        self.assert_fails("already sealed")

    def test_ambiguous_same_commit_runs(self) -> None:
        self.record("one", commit=False)
        self.record("two", commit=False)
        self.commit("two at once")
        self.assert_fails("ambiguous")


    def j5a_records(self, omit=None, bad=None):
        for i, key in enumerate(J5A):
            if key == omit:
                continue
            tier, kind, phase, target = key
            failed = key == bad
            lane = "drift-replay" if kind == "drift-replay" else "outbox"
            provenance = ({"github_run_id": str(1000 + i), "github_run_attempt": "1", "lane": lane,
                           "artifact_name": f"heavy-{lane}-{self.sha}-{1000 + i}-1",
                           "workflow_path": ".github/workflows/inbox-heavy-verification.yml",
                           "workflow_input_sha": self.sha, "event": "workflow_dispatch", "head_branch": "main"}
                          if target == "disposable" else None)
            completed = f"2026-09-28T12:{i:02}:00Z"
            name = (f"shared-readonly-{phase}-20260928T12{i:02}00000Z" if kind == "shared-readonly" else str(1000 + i))
            self.record(name, tier=tier, kind=kind, phase=phase, target=target,
                        verdict="FAIL" if failed else "PASS", completed=completed, extra=provenance)

    def test_j5a_required_key_missing_negative(self):
        self.j5a_records(omit=J5A[3])
        with self.assertRaisesRegex(EvidenceError, "missing required check"):
            evaluate(self.repo, "j5a", self.sha)

    def test_perf_120k_cannot_replace_missing_dry_run(self):
        self.j5a_records(omit=J5A[0])
        self.record("perf", kind="perf-120k", phase="n/a", target="disposable",
                    completed="2026-09-28T13:00:00Z", extra=self.perf_provenance())
        with self.assertRaisesRegex(EvidenceError, "missing required check.*migration-dry-run"):
            evaluate(self.repo, "j5a", self.sha)

    def perf_provenance(self):
        return {"github_run_id": "2000", "github_run_attempt": "1", "lane": "perf-120k",
                "artifact_name": f"heavy-perf-120k-{self.sha}-2000-1",
                "workflow_path": ".github/workflows/inbox-heavy-verification.yml",
                "workflow_input_sha": self.sha, "event": "workflow_dispatch", "head_branch": "main"}

    def test_unknown_kind_rejected(self):
        self.record(kind="outside-enum")
        self.assert_fails("missing or unknown kind")

    def test_perf_120k_wrong_phase_or_target_rejected(self):
        for phase, target in (("pre", "disposable"), ("n/a", "shared-test")):
            with self.subTest(phase=phase, target=target):
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    case.record(kind="perf-120k", phase=phase, target=target,
                                extra=case.perf_provenance())
                    case.assert_fails("perf-120k requires phase n/a and target disposable")
                finally:
                    case.doCleanups()

    def test_perf_120k_requires_runner_provenance(self):
        self.record(kind="perf-120k", phase="n/a", target="disposable")
        self.assert_fails("missing runner provenance")

    def test_perf_120k_sealable_with_provenance(self):
        self.record(kind="perf-120k", phase="n/a", target="disposable",
                    extra=self.perf_provenance())
        self.assertEqual(evaluate(self.repo, self.sha, "pre-merge")["status"], "PASS")

    def test_j5a_latest_post_fail_masks_older_pass_negative(self):
        self.j5a_records()
        self.record("post-fail", kind="db-contract", phase="post", target="disposable", verdict="FAIL", completed="2026-09-28T13:00:00Z")
        with self.assertRaisesRegex(EvidenceError, "latest required check failed"):
            evaluate(self.repo, "j5a", self.sha)

    def test_j5a_browser_pass_cannot_mask_dry_run_fail_negative(self):
        self.j5a_records(bad=J5A[0])
        self.record("browser-pass", kind="browser", phase="post", target="disposable", completed="2026-09-28T13:00:00Z")
        with self.assertRaisesRegex(EvidenceError, "migration-dry-run"):
            evaluate(self.repo, "j5a", self.sha)

    def test_j5a_disposable_record_without_runner_provenance_negative(self):
        self.j5a_records()
        self.record("local-browser", kind="browser", phase="post", target="disposable",
                    completed="2026-09-28T13:00:00Z")
        with self.assertRaisesRegex(EvidenceError, "missing runner provenance"):
            evaluate(self.repo, "j5a", self.sha)

    def test_j5a_passes_complete_matrix(self):
        self.j5a_records()
        self.assertEqual(evaluate(self.repo, "j5a", self.sha)["status"], "PASS")

    def test_j5a_refuses_nonproducer_platform_config_shapes(self):
        valid = self.platform_config()
        for label, platform, message in (
            ("three keys", {key: valid[key] for key in ("postgres_major", "postgrest_major", "gotrue_major")}, "invalid consumed platform data"),
            ("wrong sha256", {**valid, "sha256": "0" * 64}, "platform mismatch|consumed platform digest mismatch"),
        ):
            with self.subTest(label=label):
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    case.platform_config_override = platform
                    case.j5a_records()
                    with case.assertRaisesRegex(EvidenceError, message):
                        evaluate(case.repo, "j5a", case.sha)
                finally:
                    case.doCleanups()

    def test_shared_readonly_rejects_unwaived_not_verified_digest(self):
        def mutate(manifest, directory):
            output_path = directory / "readonly.json"
            output = json.loads(output_path.read_text())
            majors = {"postgres_major": "17", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "2"}
            output["comparisons"]["platform"]["observed_sha256"] = hashlib.sha256(json.dumps(majors, separators=(",", ":")).encode()).hexdigest()
            output_path.write_text(json.dumps(output))
            manifest["artifacts"]["readonly.json"] = hashlib.sha256(output_path.read_bytes()).hexdigest()

        self.shared_mutation = mutate
        self.j5a_records()
        with self.assertRaisesRegex(EvidenceError, "platform mismatch|waived fields mismatch"):
            evaluate(self.repo, "j5a", self.sha)

    def test_shared_readonly_rejects_waiver_for_matching_observed_digest(self):
        def mutate(manifest, directory):
            output_path = directory / "readonly.json"
            output = json.loads(output_path.read_text())
            output["comparisons"]["platform"]["waived_fields"] = ["postgrest_major"]
            output["comparisons"]["platform"]["verdict"] = {"postgres_major": "PASS", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "PASS"}
            manifest["waived_fields"] = ["postgrest_major"]
            output_path.write_text(json.dumps(output))
            manifest["artifacts"]["readonly.json"] = hashlib.sha256(output_path.read_bytes()).hexdigest()

        self.shared_mutation = mutate
        self.j5a_records()
        with self.assertRaisesRegex(EvidenceError, "platform mismatch|waived fields mismatch"):
            evaluate(self.repo, "j5a", self.sha)

    def test_shared_readonly_rejects_waiver_for_observed_major_different_from_baseline(self):
        def mutate(manifest, directory):
            output_path = directory / "readonly.json"
            output = json.loads(output_path.read_text())
            majors = {"postgres_major": "17", "postgrest_major": "13", "gotrue_major": "2"}
            output["comparisons"]["platform"]["waived_fields"] = ["postgrest_major"]
            output["comparisons"]["platform"]["verdict"] = {"postgres_major": "PASS", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "PASS"}
            output["comparisons"]["platform"]["observed_sha256"] = hashlib.sha256(json.dumps(majors, separators=(",", ":")).encode()).hexdigest()
            manifest["waived_fields"] = ["postgrest_major"]
            output_path.write_text(json.dumps(output))
            manifest["artifacts"]["readonly.json"] = hashlib.sha256(output_path.read_bytes()).hexdigest()

        self.shared_mutation = mutate
        self.j5a_records()
        with self.assertRaisesRegex(EvidenceError, "platform mismatch|waived fields mismatch"):
            evaluate(self.repo, "j5a", self.sha)

    def test_shared_readonly_rejects_mixed_names_observed_major_different_from_baseline(self):
        def mutate(manifest, directory):
            output_path = directory / "readonly.json"
            output = json.loads(output_path.read_text())
            platform = {"postgres_major": "17", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "2", "postgrest_reason": "MIXED_NAMES", "postgrest_observed_major": "13"}
            output["platform_config"] = {**platform, "sha256": evidence.platform_digest(platform)}
            output["summary"] = evidence.hosted_platform_summary(evidence.NOT_VERIFIED, "MIXED_NAMES")
            output["comparisons"]["platform"].update(waived_fields=["postgrest_major"], waiver_reasons={"postgrest_major": "MIXED_NAMES"}, verdict={"postgres_major": "PASS", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "PASS"}, observed_sha256=output["platform_config"]["sha256"])
            manifest.update(waived_fields=["postgrest_major"], waiver_reasons={"postgrest_major": "MIXED_NAMES"})
            output_path.write_text(json.dumps(output))
            manifest["artifacts"]["readonly.json"] = hashlib.sha256(output_path.read_bytes()).hexdigest()

        self.shared_mutation = mutate
        self.j5a_records()
        with self.assertRaisesRegex(EvidenceError, "platform mismatch"):
            evaluate(self.repo, "j5a", self.sha)

    def test_shared_readonly_rejects_not_verified_disposable_baseline(self):
        self.platform_config_override = {
            "postgres_major": "17", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "2",
            "sha256": hashlib.sha256(json.dumps({"postgres_major": "17", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "2"}, separators=(",", ":")).encode()).hexdigest(),
        }
        self.platform_config = lambda: self.platform_config_override
        self.j5a_records()
        with self.assertRaisesRegex(EvidenceError, "invalid consumed platform data"):
            evaluate(self.repo, "j5a", self.sha)

    def test_j5a_missing_browser_post_names_key_six(self):
        self.j5a_records(omit=J5A[6])
        with self.assertRaisesRegex(EvidenceError, "browser.*post.*disposable"):
            evaluate(self.repo, "j5a", self.sha)

    def test_shared_readonly_project_ref_provenance_and_linkage_controls(self):
        def wrong_ref(manifest, directory):
            manifest["target_binding"]["project_ref"] = "other"
        def missing_operator(manifest, directory):
            manifest["operator_script_sha256"].pop("scripts/outbox-db-contract-readonly.mjs")
        def wrong_input(manifest, directory):
            manifest["inputs"]["catalog_record"]["sha256"] = "0" * 64
        def wrong_phase(manifest, directory):
            manifest["inputs"]["platform_record"]["directory"] = manifest["inputs"]["catalog_record"]["directory"]
        def raw_content(manifest, directory):
            output = json.loads((directory / "readonly.json").read_text())
            output["content"] = "raw"
            data = json.dumps(output).encode()
            (directory / "readonly.json").write_bytes(data)
            manifest["artifacts"]["readonly.json"] = hashlib.sha256(data).hexdigest()
        for mutation, message in ((wrong_ref, "project_ref"), (missing_operator, "operator provenance"),
                                  (wrong_input, "catalog_record"), (wrong_phase, "platform_record"),
                                  (raw_content, "raw or malformed")):
            with self.subTest(message=message):
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    case.shared_mutation = mutation
                    case.j5a_records()
                    with case.assertRaisesRegex(EvidenceError, message):
                        evaluate(case.repo, "j5a", case.sha)
                finally:
                    case.doCleanups()

    def test_shared_readonly_rejects_forged_or_extra_fields(self):
        def mutate_output(change):
            def mutation(manifest, directory):
                path = directory / "readonly.json"
                output = json.loads(path.read_text())
                change(output, manifest)
                data = json.dumps(output).encode()
                path.write_bytes(data)
                manifest["artifacts"]["readonly.json"] = hashlib.sha256(data).hexdigest()
            return mutation
        cases = (
            ("platform digest", mutate_output(lambda o, m: o["comparisons"]["platform"].update(observed_sha256="0" * 64))),
            ("catalog comparison", mutate_output(lambda o, m: o["comparisons"]["catalog"].update(verdict="FAIL"))),
            ("catalog observed", mutate_output(lambda o, m: o["comparisons"]["catalog"]["observed_section_sha256"].update(relations="0" * 64))),
            ("input hash", mutate_output(lambda o, m: o["comparisons"]["platform"].update(input_sha256="0" * 64))),
            ("platform per-field verdict", mutate_output(lambda o, m: o["comparisons"]["platform"].update(verdict={"postgres_major": "PASS", "postgrest_major": evidence.NOT_VERIFIED, "gotrue_major": "PASS"}))),
            ("stability probe", mutate_output(lambda o, m: (o["items"].update(queued_invariants={"verdict": "INCONCLUSIVE", "stability_probe": {"message_body": "private"}}), m["items"].update(o["items"])))),
            ("queued diff omitted", mutate_output(lambda o, m: (o["items"].update(queued_invariants={"verdict": "PASS"}), m["items"].update(o["items"])))),
            ("empty INCONCLUSIVE diff", mutate_output(lambda o, m: (o["items"].update(queued_invariants={"verdict": "INCONCLUSIVE", "diff": hashlib.sha256(b"[]").hexdigest()}), m["items"].update(o["items"])))),
            ("extra output", mutate_output(lambda o, m: o["comparisons"]["platform"].update(message_body="private"))),
            ("extra manifest", lambda m, d: m.update(message_body="private")),
            ("waiver omitted", lambda m, d: m.pop("waived_fields")),
            ("waiver forged", lambda m, d: m.update(waived_fields=["postgres_major"])),
        )
        for label, mutation in cases:
            with self.subTest(label=label):
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    case.shared_mutation = mutation
                    case.j5a_records()
                    with case.assertRaises(EvidenceError):
                        evaluate(case.repo, "j5a", case.sha)
                finally:
                    case.doCleanups()

    def test_shared_readonly_rejects_every_missing_catalog_section_and_extra(self):
        for omitted in (*self.catalog_config()["section_sha256"], None):
            with self.subTest(omitted=omitted):
                case = SealedEvidenceTests(methodName="test_valid_sealed_record")
                case.setUp()
                try:
                    config = case.catalog_config()
                    if omitted:
                        del config["section_sha256"][omitted]
                    else:
                        config["section_sha256"]["unexpected"] = "c" * 64
                    case.catalog_config = lambda: config
                    case.j5a_records()
                    with case.assertRaisesRegex(EvidenceError, "(?i)catalog[_ ]mismatch"):
                        evaluate(case.repo, "j5a", case.sha)
                finally:
                    case.doCleanups()

    def test_missing_kind_phase_target_negative(self):
        for field in ("kind", "phase", "target"):
            case = SealedEvidenceTests(methodName="test_valid_sealed_record")
            case.setUp()
            try:
                directory = case.record(commit=False)
                manifest_path = directory / "manifest.json"
                manifest = json.loads(manifest_path.read_text())
                del manifest[field]
                manifest_path.write_text(json.dumps(manifest))
                case.commit("missing field")
                case.assert_fails(f"missing or unknown {field}")
            finally:
                case.doCleanups()

    def test_run_attempt_artifact_mismatch_negative(self):
        self.record(extra={"github_run_id": "123", "github_run_attempt": "2", "lane": "outbox",
                           "artifact_name": f"heavy-outbox-{self.sha}-123-1"})
        self.assert_fails("run_attempt/artifact mismatch")

    def test_external_artifacts_negative(self):
        self.record(extra={"external_artifacts": {}})
        self.assert_fails("external_artifacts forbidden")

    def test_artifact_listed_absent_negative(self):
        directory = self.record(commit=False)
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"]["missing.log"] = "a" * 64
        manifest_path.write_text(json.dumps(manifest))
        self.commit("missing artifact")
        self.assert_fails("artifact inventory mismatch")

    def migration_record(self, *, head_sha=None, conclusion="success", after=None, fingerprint=None):
        self.record("migration", tier="test-env", kind="migration-apply", phase="post", target="shared-test",
                    extra={"target_binding": {"project_ref": "ncsngxlcyxylaeskiteu"},
                           "workflow_run": {"workflow_path": ".github/workflows/db-migrate-test.yml", "run_id": "123", "run_attempt": 1,
                                            "head_sha": head_sha or self.sha, "conclusion": conclusion,
                                            "apply_job": {"name": "Apply migrations to test", "id": "456", "run_id": "123",
                                                          "run_attempt": 1, "conclusion": "success"}},
                           "migration_head_sha": self.sha, "schema_migrations_before": ["old"], "schema_migrations_after": after or ["old", *sorted(MIGRATION_VERSIONS)],
                           "catalog_fingerprint_after": fingerprint or {"tables": "ok"}})

    def complete_migration_record(self, *, target="shared-test", apply_conclusion="success", apply_attempt=2,
                                  include_apply=True, bind_conclusion="success", bind_attempt=2,
                                  include_replay=True, replay_target_ref=None):
        catalog = self.record("catalog", kind="catalog-fingerprint", phase="n/a", target="production" if target == "production" else "disposable",
                              commit=False, extra=self.perf_provenance())
        artifact = catalog / "catalog-fingerprint-post.json"
        artifact.write_text(json.dumps(self.catalog_config()))
        manifest_path = catalog / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"][artifact.name] = hashlib.sha256(artifact.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        drift_data = None
        if include_replay:
            drift = self.record("drift", kind="drift-replay", phase="n/a", target="disposable", commit=False,
                                extra={"github_run_id": "1002", "github_run_attempt": "1", "lane": "drift-replay",
                                       "artifact_name": f"heavy-drift-replay-{self.sha}-1002-1",
                                       "workflow_path": ".github/workflows/inbox-heavy-verification.yml", "workflow_input_sha": self.sha,
                                       "event": "workflow_dispatch", "head_branch": "main"})
            drift_artifact = f"drift-record-{'copflsklaefwzipsrjqz' if target == 'production' else 'ncsngxlcyxylaeskiteu'}.json"
            drift_data = json.loads((drift / drift_artifact).read_text())
            if replay_target_ref is not None:
                replacement = json.loads((drift / f"drift-record-{replay_target_ref}.json").read_text())
                (drift / drift_artifact).write_text(json.dumps(replacement))
                drift_data = replacement
                manifest_path = drift / "manifest.json"
                manifest = json.loads(manifest_path.read_text())
                manifest["artifacts"][drift_artifact] = hashlib.sha256((drift / drift_artifact).read_bytes()).hexdigest()
                manifest_path.write_text(json.dumps(manifest))
            expected_after = evidence.reconstruct_drift_catalog(self.catalog_config(), drift_data)
        else:
            expected_after = self.catalog_config()
        self.commit("catalog")
        production = target == "production"
        workflow = {"workflow_path": f".github/workflows/db-migrate-{'prod' if production else 'test'}.yml",
                    "run_id": "123", "run_attempt": 2, "head_sha": self.sha, "conclusion": "success"}
        if include_apply:
            workflow["apply_job"] = {"name": f"Apply migrations to {'prod' if production else 'test'}",
                                     "id": "456", "run_id": "123", "run_attempt": apply_attempt,
                                     "conclusion": apply_conclusion}
        if production:
            workflow["bind_upstream_job"] = {"name": "Bind upstream test run", "id": "789",
                                             "run_id": "123", "run_attempt": bind_attempt, "conclusion": bind_conclusion}
        self.record("migration", tier="prod-deploy" if production else "test-env", kind="migration-apply",
                    phase="post", target=target,
                    extra={"target_binding": {"project_ref": "copflsklaefwzipsrjqz" if production else "ncsngxlcyxylaeskiteu"},
                           "workflow_run": workflow, "migration_head_sha": self.sha,
                           "schema_migrations_before": ["old"],
                           "schema_migrations_after": ["old", *sorted(MIGRATION_VERSIONS)],
                           "catalog_fingerprint_after": expected_after})

    def test_migration_skipped_apply_job_negative(self):
        self.complete_migration_record(apply_conclusion="skipped")
        with self.assertRaisesRegex(EvidenceError, "apply job"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_migration_apply_job_other_attempt_negative(self):
        self.complete_migration_record(apply_attempt=1)
        with self.assertRaisesRegex(EvidenceError, "apply job"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_migration_missing_apply_job_negative(self):
        self.complete_migration_record(include_apply=False)
        with self.assertRaisesRegex(EvidenceError, "apply job"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_production_failed_bind_job_negative(self):
        self.complete_migration_record(target="production", bind_conclusion="failure")
        with self.assertRaisesRegex(EvidenceError, "bind upstream job"):
            evaluate_migration(self.repo, self.sha, "production")

    def test_migration_jobs_succeed_for_same_run_and_attempt(self):
        self.complete_migration_record(apply_attempt=2)
        self.assertEqual(evaluate_migration(self.repo, self.sha, "shared-test")["status"], "PASS")

    def test_production_prior_bind_job_succeeds_for_job_only_rerun(self):
        self.complete_migration_record(target="production", apply_attempt=2, bind_attempt=1)
        # GitHub retains the successful binding job when only the gated job is rerun.
        self.assertEqual(evaluate_migration(self.repo, self.sha, "production")["status"], "PASS")

    def test_migration_rejects_changed_definition_presented_as_sealed_pre(self):
        self.complete_migration_record()
        drift = self.record("drift-replacement", kind="drift-replay", phase="n/a", target="disposable", commit=False,
                            extra={"github_run_id": "1003", "github_run_attempt": "1", "lane": "drift-replay",
                                   "artifact_name": f"heavy-drift-replay-{self.sha}-1003-1",
                                   "workflow_path": ".github/workflows/inbox-heavy-verification.yml", "workflow_input_sha": self.sha,
                                   "event": "workflow_dispatch", "head_branch": "main"})
        record_path = drift / "drift-record-ncsngxlcyxylaeskiteu.json"
        record = json.loads(record_path.read_text())
        record["items"][0]["canonical_definition"] = "text"
        record["items"][0]["definition_sha256"] = hashlib.sha256(b"text").hexdigest()
        digest_payload = {key: record[key] for key in ("record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items")}
        record["sha256"] = hashlib.sha256(json.dumps(digest_payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        record_path.write_text(json.dumps(record))
        manifest_path = drift / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"][record_path.name] = hashlib.sha256(record_path.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        self.commit("changed drift definition")
        with self.assertRaisesRegex(EvidenceError, "fixture/replay definition mismatch"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_migration_rejects_replacement_record_in_manifest(self):
        self.complete_migration_record()
        replacement = self.record("migration-replacement", tier="test-env", kind="migration-apply", phase="post", target="shared-test", commit=False,
                                  extra={"target_binding": {"project_ref": "ncsngxlcyxylaeskiteu"},
                                         "workflow_run": {"workflow_path": ".github/workflows/db-migrate-test.yml", "run_id": "124", "run_attempt": 1, "head_sha": self.sha, "conclusion": "success",
                                                          "apply_job": {"name": "Apply migrations to test", "id": "457", "run_id": "124", "run_attempt": 1, "conclusion": "success"}},
                                         "migration_head_sha": self.sha, "schema_migrations_before": ["old"], "schema_migrations_after": ["old", *sorted(MIGRATION_VERSIONS)],
                                         "catalog_fingerprint_after": {"tables": "ok"}})
        manifest_path = replacement / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["catalog_drift_record"] = {"items": "replacement-from-manifest"}
        manifest_path.write_text(json.dumps(manifest))
        self.commit("manifest drift replacement")
        with self.assertRaisesRegex(EvidenceError, "migration manifest cannot supply a replacement drift record"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_migration_requires_a_linked_replay(self):
        self.complete_migration_record(include_replay=False)
        with self.assertRaisesRegex(EvidenceError, "missing required check"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_production_migration_cannot_use_test_replay_record(self):
        self.complete_migration_record(target="production", replay_target_ref="ncsngxlcyxylaeskiteu")
        with self.assertRaisesRegex(EvidenceError, "drift replay item or binding mismatch"):
            evaluate_migration(self.repo, self.sha, "production")

    def test_migration_wrong_head_negative(self):
        self.migration_record(head_sha="0" * 40)
        with self.assertRaisesRegex(EvidenceError, "workflow identity"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_migration_failed_conclusion_negative(self):
        self.migration_record(conclusion="failure")
        with self.assertRaisesRegex(EvidenceError, "workflow identity"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_migration_missing_version_negative(self):
        self.migration_record(after=["old", *sorted(MIGRATION_VERSIONS)[:2]])
        with self.assertRaisesRegex(EvidenceError, "ledger versions"):
            evaluate_migration(self.repo, self.sha, "shared-test")

    def test_migration_fingerprint_section_mismatch_negative(self):
        self.git("checkout", "-qb", "evidence", self.sha)
        directory = self.record("catalog", kind="catalog-fingerprint", phase="n/a", target="disposable", commit=False,
                                extra=self.perf_provenance())
        fingerprint = directory / "catalog-fingerprint-post.json"
        fingerprint.write_text(json.dumps(self.catalog_config()))
        manifest_path = directory / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["artifacts"][fingerprint.name] = hashlib.sha256(fingerprint.read_bytes()).hexdigest()
        manifest_path.write_text(json.dumps(manifest))
        self.record("drift", kind="drift-replay", phase="n/a", target="disposable", commit=False,
                    extra={"github_run_id": "1002", "github_run_attempt": "1", "lane": "drift-replay",
                           "artifact_name": f"heavy-drift-replay-{self.sha}-1002-1",
                           "workflow_path": ".github/workflows/inbox-heavy-verification.yml", "workflow_input_sha": self.sha,
                           "event": "workflow_dispatch", "head_branch": "main"})
        self.commit("catalog")
        self.git("checkout", "-q", self.base_branch)
        (self.repo / "main.txt").write_text("main")
        self.commit("main")
        m = self.git("rev-parse", "HEAD")
        self.record("migration", sha=m, tier="test-env", kind="migration-apply", phase="post", target="shared-test",
                    extra={"target_binding": {"project_ref": "ncsngxlcyxylaeskiteu"},
                           "workflow_run": {"workflow_path": ".github/workflows/db-migrate-test.yml", "run_id": "123", "run_attempt": 1,
                                            "head_sha": m, "conclusion": "success",
                                            "apply_job": {"name": "Apply migrations to test", "id": "456", "run_id": "123",
                                                          "run_attempt": 1, "conclusion": "success"}},
                           "migration_head_sha": self.sha, "schema_migrations_before": ["old"], "schema_migrations_after": ["old", *sorted(MIGRATION_VERSIONS)],
                           "catalog_fingerprint_after": {"tables": "mismatch", "policies": "same"}})
        with self.assertRaisesRegex(EvidenceError, "catalog fingerprint section mismatch"):
            evaluate_migration(self.repo, m, "shared-test", x_mig=self.sha)

    def test_j5b_migration_diff_negative(self):
        self.j5a_records()
        (self.repo / "supabase/migrations").mkdir(parents=True)
        (self.repo / "supabase/migrations/new.sql").write_text("SELECT 1")
        self.commit("main migration change")
        m = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(EvidenceError, "migration diff"):
            evaluate(self.repo, "j5b", self.sha, m)

    def test_j5b_main_chain_cannot_mask_migration_chain_fail(self):
        self.git("checkout", "-qb", "migration-evidence", self.sha)
        self.j5a_records(bad=J5A[3])
        self.record("burst", kind="burst", phase="n/a", target="disposable", completed="2026-09-28T12:08:00Z",
                    extra={"github_run_id": "2000", "github_run_attempt": "1", "lane": "outbox",
                           "artifact_name": f"heavy-outbox-{self.sha}-2000-1",
                           "workflow_path": ".github/workflows/inbox-heavy-verification.yml",
                           "workflow_input_sha": self.sha, "event": "workflow_dispatch", "head_branch": "main"})
        self.git("checkout", "-q", self.base_branch)
        (self.repo / "main.txt").write_text("main")
        self.commit("main")
        m = self.git("rev-parse", "HEAD")
        self.record("masked-post", sha=m, kind="db-contract", phase="post", target="disposable",
                    extra={"github_run_id": "3000", "github_run_attempt": "1", "lane": "outbox",
                           "artifact_name": f"heavy-outbox-{m}-3000-1",
                           "workflow_path": ".github/workflows/inbox-heavy-verification.yml",
                           "workflow_input_sha": m, "event": "workflow_dispatch", "head_branch": "main"})
        self.record("migration", sha=m, tier="test-env", kind="migration-apply", phase="post", target="shared-test",
                    completed="2026-09-28T12:01:00Z")
        self.record("readonly", sha=m, tier="test-env", kind="shared-readonly", phase="post", target="shared-test",
                    completed="2026-09-28T12:02:00Z")
        with patch("sealed_evidence.evaluate_migration", return_value={"status": "PASS"}):
            with self.assertRaisesRegex(EvidenceError, "latest required check failed.*db-contract"):
                evaluate(self.repo, "j5b", self.sha, m)

    def test_deploy_entrypoint_fails_closed(self) -> None:
        observed = {
            "vercel_git_commit_sha": "0" * 40,
            "railway_git_commit_sha": self.sha,
            "railway_deployment_id": "deployment-1",
        }
        self.record(tier="test-env", observed=observed)
        with self.assertRaisesRegex(EvidenceError, "observed commit mismatch"):
            evaluate_deploy(self.repo, self.sha, "test-env")
        observed["vercel_git_commit_sha"] = self.sha
        self.record("matching", tier="test-env", observed=observed, completed="2026-09-28T13:00:00Z")
        with self.assertRaisesRegex(EvidenceError, "awaits authenticated source and schema verification"):
            evaluate_deploy(self.repo, self.sha, "test-env")


if __name__ == "__main__":
    unittest.main()
