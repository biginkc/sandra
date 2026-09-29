"""Opt-in mutation proof. Run only against the owned sandra-mig-r7 scratch DB."""
import importlib.util
import os
from pathlib import Path
import subprocess
import unittest


spec = importlib.util.spec_from_file_location('catalog_fingerprint', Path(__file__).with_name('catalog_fingerprint.py'))
f = importlib.util.module_from_spec(spec)
spec.loader.exec_module(f)


@unittest.skipUnless(os.environ.get('CATALOG_FINGERPRINT_SCRATCH') == 'sandra-mig-r7', 'owned scratch DB required')
class LiveCatalogMutation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.environ.get('CATALOG_FINGERPRINT_SCRATCH') != 'sandra-mig-r7':
            return
        cls.sql('''CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version text);
CREATE TABLE public.fp_probe (id integer PRIMARY KEY, name text DEFAULT 'a  b'::text);
CREATE INDEX fp_probe_name_idx ON public.fp_probe(name);
CREATE FUNCTION public.fp_fn() RETURNS text LANGUAGE sql SECURITY INVOKER SET search_path = public AS $$SELECT 'a  b'::text$$;
CREATE FUNCTION public.fp_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
CREATE TRIGGER fp_trigger BEFORE INSERT ON public.fp_probe FOR EACH ROW EXECUTE FUNCTION public.fp_trigger();
ALTER TABLE public.fp_probe ENABLE ROW LEVEL SECURITY;
CREATE POLICY fp_policy ON public.fp_probe AS PERMISSIVE FOR SELECT TO PUBLIC USING (name = 'a  b'::text);
''')
        cls.ids = ['public.fp_probe', 'public.fp_fn']
        cls.scope = {'created_indexes': ['public.fp_probe_name_idx'], 'created_triggers': ['public.fp_probe.fp_trigger']}

    @staticmethod
    def sql(statement):
        subprocess.run(['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-q'], input=statement, text=True,
                       check=True, capture_output=True)

    def hash(self, section):
        return f.fingerprint(f.read_catalog(self.ids, self.scope))['section_sha256'][section]

    def assert_flips(self, section, change):
        before = self.hash(section)
        self.sql(change)
        self.assertNotEqual(before, self.hash(section), change)

    def test_trigger_enablement(self):
        self.assert_flips('relations', 'ALTER TABLE public.fp_probe DISABLE TRIGGER fp_trigger;')

    def test_policy_permissiveness(self):
        self.assert_flips('relations', '''DROP POLICY fp_policy ON public.fp_probe;
CREATE POLICY fp_policy ON public.fp_probe AS RESTRICTIVE FOR SELECT TO PUBLIC USING (name = 'a  b'::text);''')

    def test_index_validity(self):
        self.assert_flips('relations', "SET allow_system_table_mods = on; UPDATE pg_catalog.pg_index SET indisvalid = false WHERE indexrelid = 'public.fp_probe_name_idx'::regclass;")

    def test_rls_enablement(self):
        self.assert_flips('relations', 'ALTER TABLE public.fp_probe DISABLE ROW LEVEL SECURITY;')

    def test_security_definer(self):
        self.assert_flips('functions', 'ALTER FUNCTION public.fp_fn() SECURITY DEFINER;')


if __name__ == '__main__':
    unittest.main()
