from pathlib import Path
import subprocess,json,re,hashlib
root=Path(__file__).resolve().parents[2]
folder=root/'experiments/inbox-sync-authority-batch'
def sql(q):
 return subprocess.check_output(['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock','exec','-i','sandra-inbox-projection-t2-db','psql','-XqAt','-U','supabase_admin','-d','sandra_inbox_install_20260913','-v','ON_ERROR_STOP=1'],input=q,text=True).strip()
assert sql("SELECT marker FROM install_fixture.identity")=='sandra-inbox-production-candidate-owned-synthetic'
source=(folder/'setup.sql').read_text();bodies={}
for schema,name,body in re.findall(r'CREATE OR REPLACE FUNCTION (\w+)\.(\w+)\(.*?AS \$\$(.*?)\$\$;',source,re.S):
 actual=sql(f"SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='{schema}' AND p.proname='{name}'")
 assert actual==body.strip(),f'Installed body mismatch {schema}.{name}'
 bodies[f'{schema}.{name}']=hashlib.sha256(actual.encode()).hexdigest()
assert len(bodies)==4
files=['src/app/api/inbox/sync/[scopeId]/route.test.ts','src/lib/inbox/sync-gateway.ts','src/lib/inbox/supabase-sync-repository.ts','src/lib/inbox/sync-gateway.test.ts','src/lib/inbox/supabase-sync-repository.test.ts']+[str(p.relative_to(root)) for p in folder.iterdir() if p.suffix in ['.sql','.ts','.py']]
files += [str(p.relative_to(root)) for p in (root/'experiments/inbox-volume-browser').iterdir() if p.suffix=='.ts']
manifest={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in sorted(files)}
(folder/'source-verification.json').write_text(json.dumps({'passed':True,'installedBodies':bodies,'sources':manifest},indent=2)+'\n')
print('Four installed function bodies and owned source hashes verified')
