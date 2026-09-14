"""Read-only evidence binding, not a fresh runtime test."""
import ast,hashlib,json,re
from pathlib import Path
P=Path(__file__).resolve().parent
e=json.loads((P/'evidence.json').read_text())
for key,name in [('source_sha256','setup.sql'),('runner_sha256','test.py')]:
 if e[key]!=hashlib.sha256((P/name).read_bytes()).hexdigest():raise SystemExit('Stale unknown history evidence: '+name)
ast.parse((P/'test.py').read_text())
if len(re.findall(r'CREATE FUNCTION ([\w.]+)\((.*?)\) RETURNS jsonb.*?AS \$\$(.*?)\$\$;', (P/'setup.sql').read_text(),re.S))!=3:raise SystemExit('Unknown history function coverage changed')
if len(e['checks'])!=6:raise SystemExit('Unknown history proof groups missing')
print('Six unknown history groups bind current SQL and runner; no database rerun')
