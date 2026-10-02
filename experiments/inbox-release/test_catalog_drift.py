import copy
import hashlib
import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sealed_evidence as evidence


class CatalogDriftMutationTests(unittest.TestCase):
    def setUp(self):
        sections = {name: [] for name in evidence.CATALOG_SECTIONS}
        sections["relations"] = [
            {"identity": "public.message_threads", "owner": "postgres", "columns": [{"name": "existing", "type": "uuid", "not_null": False, "default": None, "acl": None, "attgenerated": "", "attidentity": ""}], "indexes": [], "constraints": [], "triggers": [], "policies": []},
            {"identity": "auth.users", "owner": "supabase_auth_admin", "columns": [], "indexes": [], "constraints": [], "triggers": [], "policies": []},
            {"identity": "inbox_parent.work", "owner": "postgres", "columns": [], "indexes": [], "constraints": [], "triggers": [], "policies": []},
        ]
        self.baseline = evidence.catalog_digest(sections)

    def column(self, object_name="public.message_threads", name="new_column"):
        return {"object": object_name, "attribute": "columns", "name": name, "canonical_definition": "uuid", "definition_sha256": hashlib.sha256(b"uuid").hexdigest(),
                "classification": {"class": "column", "nullable": True, "default": None, "attidentity": "", "attgenerated": "", "column_acl": None, "owner": "postgres"},
                "origin": "unknown", "approval_sha256": None}

    def index(self, name="idx_new", **overrides):
        classification = {"class": "index", "unique": False, "primary": False, "constraint": False, "valid": True, "ready": True, "live": True,
                          "predicate": None, "expression": False, "owner": "postgres", **overrides}
        definition = f"CREATE INDEX {name} ON public.message_threads USING btree (existing)"
        return {"object": "public.message_threads", "attribute": "indexes", "name": name,
                "canonical_definition": definition, "definition_sha256": hashlib.sha256(definition.encode()).hexdigest(),
                "classification": classification, "origin": "unknown", "approval_sha256": None}

    def record(self, items=None, *, target_ref="ncsngxlcyxylaeskiteu", candidate_sha="a" * 40, baseline=None):
        baseline = baseline or self.baseline
        record = {"record_version": 1, "target_ref": target_ref, "candidate_sha": candidate_sha, "baseline_digest": baseline["sha256"],
                  "catalog_format_version": evidence.CATALOG_FORMAT_VERSION, "items": items or [self.column()]}
        payload = {key: record[key] for key in ("record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items")}
        record["sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        return record

    def assert_rejects(self, record, *, baseline=None, bound=None, target_ref="ncsngxlcyxylaeskiteu", candidate_sha="a" * 40):
        with self.assertRaises(evidence.EvidenceError):
            evidence.reconstruct_drift_catalog(baseline or self.baseline, record, bound_baseline_digest=bound,
                                               target_ref=target_ref, candidate_sha=candidate_sha)

    def refresh(self, record):
        payload = {key: record[key] for key in ("record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items")}
        record["sha256"] = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()

    def test_gate_section9_mutations(self):
        valid = self.record()
        observed = evidence.reconstruct_drift_catalog(self.baseline, valid, target_ref="ncsngxlcyxylaeskiteu", candidate_sha="a" * 40)
        mutations = [
            ("duplicate entry", lambda r: r["items"].append(copy.deepcopy(r["items"][0]))),
            ("baseline override", lambda r: r["items"][0].update(name="existing")),
            ("default column", lambda r: r["items"][0]["classification"].update(default="now()")),
            ("identity column", lambda r: r["items"][0]["classification"].update(attidentity="d")),
            ("generated column", lambda r: r["items"][0]["classification"].update(attgenerated="s")),
            ("column ACL", lambda r: r["items"][0]["classification"].update(column_acl="{postgres=r}")),
            ("unknown class", lambda r: r["items"][0].update(attribute="triggers")),
            ("malformed canonical definition", lambda r: r["items"][0].update(canonical_definition="")),
            ("section-level entry", lambda r: r["items"][0].update(object="sections")),
            ("attribute-level entry", lambda r: r["items"][0].update(attribute="relations")),
            ("wrong ref", lambda r: r.update(target_ref="wrong")),
            ("wrong SHA", lambda r: r.update(candidate_sha="b" * 40)),
            ("wrong baseline digest", lambda r: r.update(baseline_digest="c" * 64)),
            ("wrong format", lambda r: r.update(catalog_format_version=3)),
            ("mislabelled origin", lambda r: r["items"][0].update(origin="platform")),
            ("rowtype-table item", lambda r: r["items"][0].update(object="inbox_parent.work")),
            ("operator-index name collision", lambda r: r.update(items=[self.index("inbox_parent_message_property")])),
            ("unique index", lambda r: r.update(items=[self.index("idx_unique", unique=True)])),
            ("invalid index", lambda r: r.update(items=[self.index("idx_invalid", valid=False)])),
            ("unready index", lambda r: r.update(items=[self.index("idx_unready", ready=False)])),
            ("non-live index", lambda r: r.update(items=[self.index("idx_dead", live=False)])),
            ("unapproved predicate", lambda r: r.update(items=[self.index("idx_bad_predicate", predicate="(existing IS NOT NULL)")])),
            ("expression-only index", lambda r: r.update(items=[self.index("idx_bad_expression", expression=True)])),
            ("approval digest mismatch", lambda r: r.update(items=[self.index("idx_message_threads_ai_responder_status", predicate="(ai_responder_status IS NOT NULL)", approval_sha256="d" * 64)])),
            ("approval definition digest mismatch", lambda r: r.update(items=[dict(self.index("idx_message_threads_ai_responder_status", predicate="(ai_responder_status IS NOT NULL)"), approval_sha256=evidence.DRIFT_APPROVALS["idx_message_threads_ai_responder_status"], canonical_definition="CREATE INDEX idx_message_threads_ai_responder_status ON public.message_threads USING btree (changed)", definition_sha256=hashlib.sha256(b"CREATE INDEX idx_message_threads_ai_responder_status ON public.message_threads USING btree (changed)").hexdigest())])),
            ("constraint-backed index", lambda r: r.update(items=[self.index("idx_constraint", constraint=True)])),
        ]
        for label, mutate in mutations:
            with self.subTest(label=label):
                record = copy.deepcopy(valid)
                mutate(record)
                self.refresh(record)
                self.assert_rejects(record)

        missing = copy.deepcopy(self.baseline)
        missing["sections"]["relations"][0]["columns"] = []
        self.assert_rejects(valid, baseline=missing)
        post = evidence.reconstruct_drift_catalog(self.baseline, valid)
        substituted = copy.deepcopy(valid)
        substituted["baseline_digest"] = post["sha256"]
        self.refresh(substituted)
        self.assert_rejects(substituted, baseline=self.baseline)
        post_collision = self.record(baseline=post)
        self.assert_rejects(post_collision, baseline=post)

        stale = copy.deepcopy(valid)
        stale["items"][0]["canonical_definition"] = "text"
        stale["items"][0]["definition_sha256"] = hashlib.sha256(b"text").hexdigest()
        self.refresh(stale)
        self.assertNotEqual(evidence.reconstruct_drift_catalog(self.baseline, stale)["sha256"], observed["sha256"], "stale item")
        extra = self.record([self.column(), self.index()])
        self.assertNotEqual(evidence.reconstruct_drift_catalog(self.baseline, extra)["sha256"], observed["sha256"], "unrecorded extra")

    def test_gate_rejects_replacement_item_absent_from_sealed_pre(self):
        original = self.record()
        replacement = self.record([self.column(name="different")])
        with self.assertRaisesRegex(evidence.EvidenceError, "absent from sealed PRE"):
            evidence.validate_replacement_drift_record(original, replacement)

    def test_gate_replacement_requires_full_definition_and_sealed_replay(self):
        original = self.record()
        replacement = copy.deepcopy(original)
        replacement["items"][0]["canonical_definition"] = "text"
        replacement["items"][0]["definition_sha256"] = hashlib.sha256(b"text").hexdigest()
        self.refresh(replacement)
        passing_replay = {"exit_status": 0, "manifest": {"verdict": "PASS"}}
        with self.assertRaisesRegex(evidence.EvidenceError, "absent from sealed PRE"):
            evidence.validate_replacement_drift_record(original, replacement, replay_run=passing_replay)
        with self.assertRaisesRegex(evidence.EvidenceError, "not linked"):
            evidence.validate_replacement_drift_record(original, original, replay_run={"exit_status": 0, "manifest": {"verdict": "FAIL"}})

    def test_gate_rejects_record_in_ordinary_lane(self):
        for artifact in ("drift-record.json", "drift-record-ncsngxlcyxylaeskiteu.json"):
            with self.subTest(artifact=artifact), self.assertRaisesRegex(evidence.EvidenceError, "only permitted in replay lane"):
                evidence.validate_drift_lane("browser", {artifact: "x"})

    def test_rowtype_table_guard_is_derived_from_migration_source(self):
        manifest = json.loads((Path(__file__).resolve().parents[2] / "scripts/inbox-ci/inbox-migrations.json").read_text())
        sql = [(Path(__file__).resolve().parents[2] / "supabase/migrations" / f"{entry['version']}_{entry['name']}.sql").read_text() for entry in manifest]
        self.assertEqual(evidence.derive_rowtype_tables(sql), evidence.ROWTYPE_TABLES)

    def test_rowtype_guard_detects_star_and_row_constructor_reads(self):
        synthetic = """
        SELECT m.* FROM public.messages AS m;
        SELECT * FROM public.contacts c;
        SELECT ROW(c) FROM public.contacts AS c;
        """
        self.assertEqual(evidence.derive_rowtype_tables([synthetic]), {"public.messages", "public.contacts"})


if __name__ == "__main__":
    unittest.main()
