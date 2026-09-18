#!/usr/bin/env python3
"""Real-database negative controls for the owned-fixture signature.

This intentionally creates one disposable table in a schema that older
owned_cleanup versions excluded, proves that both an ordinary content edit
and an immutable-primary-key version replacement are detected, restores the
baseline, and drops the disposable schema. It refuses to touch a pre-existing
reply schema and never deletes anything outside its exact probe schema.
"""
import json
import subprocess
import sys
import uuid
from pathlib import Path

P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'inbox-projection' / 'fixture'))
from guards import validate_container, validate_cron
import owned_cleanup

if sys.argv[1:] != ['--run-owned-fixture']:
    raise SystemExit('Explicit owned fixture required')

D = ['docker', '--host', 'unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N = 'sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D + ['inspect', N], text=True))[0])


def sql(query, timeout=30):
    result = subprocess.run(
        D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
        input=query,
        text=True,
        capture_output=True,
        timeout=timeout,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    return result.stdout.strip()


validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql("SELECT marker FROM inbox_t2_fixture.identity") != 'sandra-inbox-projection-t2-owned-synthetic':
    raise RuntimeError('Wrong fixture')
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL") != 't':
    raise RuntimeError('Refusing an existing inbox_reply_context schema')

before_tables = owned_cleanup.discover(sql)
before_all = before_tables[2]
before_baseline = owned_cleanup.snapshot_baseline(sql, before_all)
schema = 'inbox_reply_context'
table = f'{schema}.versions'
probe_id = str(uuid.uuid4())
created = False

try:
    sql(f"""
        CREATE SCHEMA {schema};
        CREATE TABLE {table}(
          id uuid NOT NULL,
          version integer NOT NULL,
          payload text NOT NULL,
          PRIMARY KEY (id, version)
        );
        INSERT INTO {table}(id,version,payload) VALUES ('{probe_id}',1,'baseline');
    """)
    created = True

    _, _, probe_tables = owned_cleanup.discover(sql)
    if table not in {name for name, _, _, _ in probe_tables}:
        raise RuntimeError('Reply-lane probe table was not discovered')
    if owned_cleanup._counter_column(sql, table) is not None:
        raise RuntimeError('Immutable version column was incorrectly allowlisted as a counter')
    probe_baseline = owned_cleanup.snapshot_baseline(sql, probe_tables)

    sql(f"UPDATE {table} SET payload='mutated' WHERE id='{probe_id}' AND version=1")
    try:
        owned_cleanup.assert_clean(sql, probe_tables, probe_baseline, set(), set())
    except RuntimeError as error:
        if table not in str(error):
            raise RuntimeError(f'Content mutation was caught without naming {table}: {error}')
        print('PASS formerly excluded reply-schema content mutation was detected')
    else:
        raise RuntimeError('Reply-schema content mutation escaped assert_clean')
    sql(f"UPDATE {table} SET payload='baseline' WHERE id='{probe_id}' AND version=1")
    owned_cleanup.assert_clean(sql, probe_tables, probe_baseline, set(), set())

    sql(f"""
        DELETE FROM {table} WHERE id='{probe_id}' AND version=1;
        INSERT INTO {table}(id,version,payload) VALUES ('{probe_id}',2,'baseline');
    """)
    try:
        owned_cleanup.assert_clean(sql, probe_tables, probe_baseline, set(), set())
    except RuntimeError as error:
        if table not in str(error):
            raise RuntimeError(f'Immutable version replacement was caught without naming {table}: {error}')
        print('PASS immutable primary-key version replacement was detected')
    else:
        raise RuntimeError('Immutable primary-key version replacement escaped assert_clean')
    sql(f"""
        DELETE FROM {table} WHERE id='{probe_id}' AND version=2;
        INSERT INTO {table}(id,version,payload) VALUES ('{probe_id}',1,'baseline');
    """)
    owned_cleanup.assert_clean(sql, probe_tables, probe_baseline, set(), set())
    print('PASS cleanup baseline restored after both negative controls')
finally:
    if created:
        sql(f'DROP SCHEMA {schema} CASCADE')

if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL") != 't':
    raise RuntimeError('Disposable reply schema was not removed')
owned_cleanup.assert_clean(sql, before_all, before_baseline, set(), set())
print('CLEANUP NEGATIVE CONTROLS: ALL GREEN')
