#!/usr/bin/env python3
"""Apply the reviewed grants and retention forward correction to an installed owned candidate."""
import argparse,hashlib,json,re
from pathlib import Path
from fixture_db import guard,sql
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
guard();gate=sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')
retention=re.search(r'CREATE FUNCTION inbox_control.prune_expired_worksets.*?END \$\$;', (P/'runtime.sql').read_text(),re.S).group().replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION',1)
sql('BEGIN;'+retention+(P/'harden-private.sql').read_text()+'COMMIT;')
if sql('SELECT serving_enabled FROM inbox_control.rollout WHERE singleton')!=gate:raise RuntimeError('Hardening changed serving gate')
# Authorization must fail at the serving gate, before missing identity handling.
# The test-only gate change rolls back, preserving any authorized browser enablement.
sql("""BEGIN;UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;
SET LOCAL ROLE authenticated;
DO $$ BEGIN
 BEGIN PERFORM public.inbox_authorize_sync(NULL);RAISE EXCEPTION 'Disabled gate served';
 EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'INBOX_NOT_READY' THEN RAISE;END IF;END;
END $$;ROLLBACK;""")
receipt={'applied':True,'correction':'exact private grants revocation and bounded cursor retention' ,'foundation_sha256':hashlib.sha256((P/'generated/install-candidate.sql').read_bytes()).hexdigest(),'companion_sha256':hashlib.sha256((P/'generated/read-companion.sql').read_bytes()).hexdigest(),'hardening_sha256':hashlib.sha256((P/'harden-private.sql').read_bytes()).hexdigest(),'preserved_serving_gate':True,'disabled_public_gate_verified':True,'scope':'Private grants and retention forward correction after recorded initial installation; not a fresh reinstallation'}
(P/'hardening-evidence.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
