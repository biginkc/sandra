#!/usr/bin/env python3
"""Fixed, empty action fixture: complete vendor Auth DDL and canonical replay, no jobs copied."""
from pathlib import Path
import hashlib,json,subprocess,sys
P=Path(__file__).resolve().parent;SOURCE=P.parent/'inbox-production-install'
sys.path.insert(0,str(SOURCE));import fixture_db as candidate
candidate.guard()
D=candidate.D;N=candidate.N;DB='sandra_inbox_action_runtime_20260913';MARKER='sandra-inbox-action-runtime-owned-synthetic'
def sql(q,db=DB):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','supabase_admin','-d',db,'-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=90)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
if sql("SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname='"+DB+"')",'postgres')=='t':
 if sql('SELECT marker FROM install_fixture.identity')!=MARKER:raise RuntimeError('Wrong existing action fixture')
else:
 sql('CREATE DATABASE '+DB+' OWNER postgres','postgres')
 sql("CREATE SCHEMA install_fixture;CREATE TABLE install_fixture.identity(marker text PRIMARY KEY);INSERT INTO install_fixture.identity VALUES('"+MARKER+"');")
if sql("SELECT to_regclass('auth.schema_migrations') IS NOT NULL")=='t' and not (P/'auth-foundation.json').exists():
 if sql('SELECT count(*) FROM auth.users')!='0' or sql('SELECT count(*) FROM auth.sessions')!='0':raise RuntimeError('Partial foundation contains identities; stop')
 sql('DROP SCHEMA auth CASCADE')
if sql("SELECT to_regclass('auth.schema_migrations') IS NOT NULL")!='t':
 schema=subprocess.check_output(D+['exec',N,'pg_dump','-U','supabase_admin','-d',candidate.DB,'--schema-only','--schema=auth'],text=True)
 # Candidate-only Inbox Auth triggers are intentionally excluded: installer adds
 # its reviewed canonical capture after every dependent schema exists.
 import re
 schema,n=re.subn(r'CREATE TRIGGER [^;]+ ON auth\.[^;]+EXECUTE FUNCTION (?:inbox_[^;]+|public\.[^;]+);','',schema,flags=re.S)
 ledger=subprocess.check_output(D+['exec',N,'pg_dump','-U','supabase_admin','-d',candidate.DB,'--data-only','--table=auth.schema_migrations','--inserts'],text=True)
 sql('BEGIN;\n'+schema+'\n'+ledger+'\nCOMMIT;')
 (P/'auth-foundation.json').write_text(json.dumps({'source_database':candidate.DB,'target_database':DB,'schema_sha256':hashlib.sha256(schema.encode()).hexdigest(),'vendor_ledger_sha256':hashlib.sha256(ledger.encode()).hexdigest(),'excluded_inbox_triggers':n,'copied_data_tables':['auth.schema_migrations'],'user_session_job_data_copied':False},indent=2)+'\n')
if sql('SELECT count(*) FROM auth.users')!='0' or sql('SELECT count(*) FROM auth.sessions')!='0':raise RuntimeError('Fresh Auth must have no users or sessions')
original=(SOURCE/'rehearse-bootstrap.py').read_text()
text=original.replace("P=Path(__file__).resolve().parent;ROOT=P.parent.parent;F=P.parent/'inbox-projection/fixture'", "P=Path("+repr(str(P))+");ROOT=Path("+repr(str(SOURCE.parent.parent))+");F=Path("+repr(str(SOURCE.parent/'inbox-projection/fixture'))+")")
text=text.replace("DB='sandra_inbox_install_20260913';MARKER='sandra-inbox-production-candidate-owned-synthetic'","DB='"+DB+"';MARKER='"+MARKER+"'")
if text==original or 'DB=\'sandra_inbox_install_20260913\'' in text:raise RuntimeError('Fixed profile substitution failed')
(P/'profile-receipt.json').write_text(json.dumps({'source_sha256':hashlib.sha256(original.encode()).hexdigest(),'executed_sha256':hashlib.sha256(text.encode()).hexdigest(),'database':DB,'marker':MARKER},indent=2)+'\n')
sys.argv=['rehearse-bootstrap.py','--resume-full-auth']
exec(compile(text,str(SOURCE/'rehearse-bootstrap.py'),'exec'),{'__file__':str(SOURCE/'rehearse-bootstrap.py'),'__name__':'__main__'})
