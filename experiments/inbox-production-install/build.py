#!/usr/bin/env python3
"""Compile pinned reviewed sources into an unactivated installation candidate; no DB connection."""
import hashlib,json,re,sys
from pathlib import Path
P=Path(__file__).resolve().parent;ROOT=P.parent.parent
sys.path.insert(0,str(P.parent/'inbox-projection/fixture'))
from transaction_envelope import normalize
m=json.loads((P/'components.json').read_text());out=P/'generated';out.mkdir(exist_ok=True)
chunks=[];indexes=[];receipts=[]
for c in m['components']:
 raw=(ROOT/c['path']).read_bytes()
 if hashlib.sha256(raw).hexdigest()!=c['sha256']:raise RuntimeError('Reviewed source changed: '+c['path'])
 s=raw.decode();guards=list(re.finditer(r'DO \$\$.*?END \$\$;',s,re.S));owned=[g for g in guards if 'inbox_t2_fixture.identity' in g.group()]
 if len(owned)!=1:raise RuntimeError('Expected exactly one explicit fixture guard: '+c['path'])
 g=owned[0];s=s[:g.start()]+s[g.end():];s,n=normalize(s)
 if n!=2:raise RuntimeError('Unexpected transaction envelope '+c['path'])
 s=s.replace('inbox_t2_','inbox_')
 if 'inbox_t2' in s:raise RuntimeError('Untranslated fixture reference')
 # Canonical indexes are independently executable CONCURRENTLY statements;
 # never hide a historical table scan inside the atomic foundation lock.
 def extract_index(x):
  q=x.group().replace('CREATE INDEX ','CREATE INDEX CONCURRENTLY ',1);indexes.append(q);return '-- Canonical index moved to separately executed concurrent-index packet.'
 s=re.sub(r'CREATE INDEX \w+ ON public\.\w+[^;]*;',extract_index,s)
 if c['id']=='auth':
  needle='BEGIN\n IF u IS NULL'
  if s.count(needle)!=1:raise RuntimeError('Authorization gate insertion drift')
  s=s.replace(needle,"BEGIN\n IF u IS NULL")
  # Session/membership authorization is intentionally independent from the
  # serving gate.  Receipts and recovery use this authority during rollback;
  # read-serving callers are rewritten below to authorize_serving().
  marker='END $$;\nALTER TABLE inbox_bridge.access_epochs ENABLE ROW LEVEL SECURITY;'
  helpers="""END $$;
CREATE FUNCTION inbox_bridge.assert_serving() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2s' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM inbox_control.rollout WHERE singleton AND serving_enabled) THEN RAISE EXCEPTION 'INBOX_NOT_READY' USING ERRCODE='55000';END IF;
END $$;
CREATE FUNCTION inbox_bridge.authorize_serving(o uuid DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE a jsonb;
BEGIN
 PERFORM inbox_bridge.assert_serving();a:=inbox_bridge.authorize(o);RETURN a;
END $$;
ALTER TABLE inbox_bridge.access_epochs ENABLE ROW LEVEL SECURITY;"""
  if s.count(marker)!=1:raise RuntimeError('Authorization helper insertion drift')
  s=s.replace(marker,helpers)
 else:
  # All read/workset callers retain the serving gate after authorize() is
  # split.  Action/operation adapters are intentionally outside this pinned
  # candidate and call authorize() for receipt/recovery instead.
  s=s.replace('inbox_bridge.authorize(', 'inbox_bridge.authorize_serving(')
 # This historical INSERT cannot be a production-size migration side effect.
 if c['id']=='queue':
  s,nq=re.subn(r'INSERT INTO inbox_maintained.queue\(org_id,target_kind,target_id\)\s+SELECT d\.org_id.*?ON CONFLICT DO NOTHING;', '-- Historical enqueue is performed by bounded backfill/repair after installation.',s,flags=re.S)
  if nq!=1:raise RuntimeError('Queue baseline removal drift')
 chunks.append('-- Component '+c['id']+'; pinned '+c['sha256']+'\n'+s)
 receipts.append({'component':c['id'],'source_sha256':c['sha256'],'compiled_sha256':hashlib.sha256(s.encode()).hexdigest()})
pre="""-- GENERATED REVIEW CANDIDATE. No production execution authorized.
BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='120s';
DO $$ BEGIN
 IF current_user<>'postgres' THEN RAISE EXCEPTION 'Expected migration role postgres';END IF;
 IF to_regclass('public.messages') IS NULL OR to_regclass('public.memberships') IS NULL OR to_regclass('auth.sessions') IS NULL THEN RAISE EXCEPTION 'Canonical schema missing';END IF;
 IF NOT has_table_privilege(current_user,'auth.sessions','SELECT') OR NOT has_table_privilege(current_user,'auth.sessions','TRIGGER') THEN RAISE EXCEPTION 'Canonical session privileges unavailable';END IF;
 IF to_regnamespace('inbox_control') IS NOT NULL THEN RAISE EXCEPTION 'Existing candidate: use validated forward upgrade, never reset';END IF;
END $$;
CREATE SCHEMA inbox_control AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_control FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_control.rollout(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),schema_version integer NOT NULL,serving_enabled boolean NOT NULL DEFAULT false,backfill_complete boolean NOT NULL DEFAULT false,reconciliation_complete boolean NOT NULL DEFAULT false,installed_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE inbox_control.rollout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_control.rollout FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO inbox_control.rollout(singleton,schema_version) VALUES(true,1);
"""
declared=set(json.loads((P/'private-schemas.json').read_text()))
created=set(re.findall(r'CREATE SCHEMA (\w+)',pre+'\n'.join(chunks)))|{'inbox_read'}
hardened=set(re.findall(r"'(inbox_\w+)'",(P/'harden-private.sql').read_text()))
if declared!=created or hardened!=declared:raise RuntimeError('Private hardening inventory drift')
post="""
-- Narrow DTO only. Do not publish maintained JSON, worksets, auth or policy tables.
ALTER TABLE inbox_bridge.summaries REPLICA IDENTITY FULL;
-- Capture remains installed; serving is disabled until independent activation gates.
COMMIT;
"""
admission=(P/'command-admission.sql').read_text()
(out/'install-candidate.sql').write_text(pre+'\n'.join(chunks)+(P/'runtime.sql').read_text()+admission+(P/'harden-private.sql').read_text()+post)
(out/'indexes.json').write_text(json.dumps(indexes,indent=2)+'\n')
for i,q in enumerate(indexes,1):(out/f'index-{i:02d}.sql').write_text(q+'\n')
(out/'rollback-serving.sql').write_text("BEGIN;UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;UPDATE inbox_control.command_admission SET enabled=false,updated_at=clock_timestamp();COMMIT;\n-- Preserve retained heads, epochs, worksets, receipts and capture. Never drop/reset them as routine rollback.\n-- Admission is disabled atomically with serving; authenticated receipt/status/recovery authority remains available.\n")
(out/'build-receipt.json').write_text(json.dumps({'components':receipts,'canonical_concurrent_indexes':len(indexes),'serving_enabled':False,'compiler_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'runtime_sha256':hashlib.sha256((P/'runtime.sql').read_bytes()).hexdigest(),'admission_sha256':hashlib.sha256(admission.encode()).hexdigest(),'hardening_sha256':hashlib.sha256((P/'harden-private.sql').read_bytes()).hexdigest(),'foundation_sha256':hashlib.sha256((out/'install-candidate.sql').read_bytes()).hexdigest(),'external_dependencies':m['external_dependencies']},indent=2)+'\n')
print(f'Compiled {len(chunks)} pinned components, {len(indexes)} separate concurrent indexes; no DB connection')
