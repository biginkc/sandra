from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
INSTALL = HERE / "electric-replication-role.production.sql"
TEARDOWN = HERE / "electric-replication-role.production-teardown.sql"


class ProductionElectricPacketTests(unittest.TestCase):
    def test_install_is_project_ref_guarded_and_records_prior_identity(self):
        source = INSTALL.read_text()
        self.assertIn("ncsngxlcyxylaeskiteu", source)
        self.assertIn("copflsklaefwzipsrjqz", source)
        self.assertIn("supplied_ref NOT IN", source)
        self.assertIn("prior_replica_identity", source)
        self.assertIn("prior_replica_identity_index", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL", source)
        self.assertIn("CREATE PUBLICATION electric_publication_inbox", source)
        self.assertNotIn("install_fixture", source)
        self.assertNotIn("sandra-inbox-http-owned-synthetic-20260917", source)

    def test_teardown_requires_receipt_and_restores_identity_without_dropping_role(self):
        source = TEARDOWN.read_text()
        self.assertIn("prior_replica_identity is required", source)
        self.assertIn("DROP PUBLICATION electric_publication_inbox", source)
        self.assertIn("ALTER ROLE inbox_electric_replication NOLOGIN", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY DEFAULT;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY NOTHING;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;", source)
        self.assertIn("ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY USING INDEX", source)
        self.assertNotIn("DROP ROLE inbox_electric_replication", source)
        self.assertNotIn("install_fixture", source)


if __name__ == "__main__":
    unittest.main()
