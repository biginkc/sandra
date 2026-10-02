"""Mutate away the post-definition REVOKE and require grant sequencing to fail."""
from pathlib import Path
import re
import unittest
import json

MANIFEST = json.loads((Path(__file__).resolve().parents[2] / 'scripts/inbox-ci/inbox-migrations.json').read_text())
MIGRATION = Path(__file__).resolve().parents[2] / 'supabase/migrations' / f"{MANIFEST[2]['version']}_{MANIFEST[2]['name']}.sql"


def assert_private_grants(sql):
    for name in ('apply_promotion_step', 'apply_unknown_step'):
        definition = re.search(r'CREATE OR REPLACE FUNCTION inbox_operation_domain\.' + name + r'\(', sql)
        revoke = re.search(r'REVOKE ALL ON FUNCTION inbox_operation_domain\.' + name + r'\(uuid,uuid,uuid,bigint\) FROM PUBLIC,anon,authenticated;', sql)
        if not definition or not revoke or revoke.start() < definition.start():
            raise AssertionError(f'{name} lacks post-definition browser/PUBLIC REVOKE')


class BackendGrants(unittest.TestCase):
    def test_generated(self):
        assert_private_grants(MIGRATION.read_text())
    def test_remove_revoke_fails(self):
        sql = MIGRATION.read_text()
        sql = sql.replace('REVOKE ALL ON FUNCTION inbox_operation_domain.apply_promotion_step(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;', '')
        with self.assertRaises(AssertionError):
            assert_private_grants(sql)

if __name__ == '__main__': unittest.main()
