"""Read-only source binding; this does not rerun PostgreSQL or verify deployment."""
import ast,hashlib,json,re
from pathlib import Path
P=Path(__file__).resolve().parent
for name in ['run.py','concurrency.py','wrapper-test.py']:
 ast.parse((P/name).read_text())
for receipt,source,source_key,runner in [
 ('evidence.json','setup.sql','setup_sha256','run.py'),
 ('concurrency-evidence.json','setup.sql','setup_sha256','concurrency.py'),
 ('wrapper-evidence.json','public-api.sql','public_api_sha256','wrapper-test.py')]:
 evidence=json.loads((P/receipt).read_text())
 for key,filename in [(source_key,source),('runner_sha256',runner)]:
  if evidence[key]!=hashlib.sha256((P/filename).read_bytes()).hexdigest():raise SystemExit('Stale evidence: '+receipt+' '+filename)
 if not evidence['checks']:raise SystemExit('Missing checks: '+receipt)
for source,namespace in [('setup.sql','inbox_t2_read'),('public-api.sql','public')]:
 declarations=re.findall(r'CREATE FUNCTION '+namespace+r'\.(\w+)\((.*?)\) RETURNS jsonb.*?AS \$\$(.*?)\$\$;', (P/source).read_text(), re.S)
 if len(declarations)!=2:raise SystemExit('Function body verifier no longer covers exact source: '+source)
print('Three SQL receipts bind current sources and runners; Python syntax and exact function parsing pass')
