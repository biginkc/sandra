#!/usr/bin/env python3
"""Install only the pinned unknown-history addition to the owned candidate."""
import argparse,json,subprocess,sys,hashlib
from pathlib import Path
from fixture_db import guard,sql,ensure_concurrent_index
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--owned-fixture',action='store_true');ap.add_argument('--indexes-only',action='store_true');a=ap.parse_args()
if not a.owned_fixture:raise SystemExit('Explicit owned fixture required')
guard();subprocess.run([sys.executable,str(P/'read-companion.py')],check=True)
if not a.indexes_only:
 if sql("SELECT to_regclass('inbox_read.unknown_history_cursors') IS NOT NULL")=='t':raise RuntimeError('Unknown companion already installed; only index resume permitted')
 sql((P/'generated/read-upgrade-unknown.sql').read_text())
indexes=[ensure_concurrent_index(q) for q in json.loads((P/'generated/read-indexes.json').read_text())]
sql("NOTIFY pgrst,'reload schema'")
subprocess.run([sys.executable,str(P/'read-companion.py'),'--owned-fixture','--verify-only'],check=True)
(P/'unknown-companion-evidence.json').write_text(json.dumps({'installed':True,'indexes':indexes,'upgrade_sha256':hashlib.sha256((P/'generated/read-upgrade-unknown.sql').read_bytes()).hexdigest(),'scope':'Owned fixture incremental install; serving state preserved'},indent=2)+'\n')
