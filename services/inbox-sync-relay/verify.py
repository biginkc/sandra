"""Read-only binding of the built runtime receipt, not a fresh runtime test."""
import ast,hashlib,json
from pathlib import Path
P=Path(__file__).resolve().parent
e=json.loads((P/'runtime-evidence.json').read_text())
for key,name in [('source_sha256','server.mjs'),('dockerfile_sha256','Dockerfile'),('runner_sha256','runtime-proof.py')]:
 if e[key]!=hashlib.sha256((P/name).read_bytes()).hexdigest():raise SystemExit('Stale relay runtime evidence: '+name)
ast.parse((P/'runtime-proof.py').read_text())
if len(e['checks'])!=4 or not e['cleanup']:raise SystemExit('Missing runtime proof or cleanup')
print('Built relay receipt matches source, image recipe and runner; no network calls')
