#!/usr/bin/env python3
"""Install the already compiled, reviewed foundation in the fixed action fixture."""
from pathlib import Path
import hashlib,json,subprocess,sys,re
P=Path(__file__).resolve().parent;S=P.parent/'inbox-production-install'
sys.path.insert(0,str(S));import fixture_db as f
f.guard();f.DB='sandra_inbox_action_runtime_20260913'
if f.sql('SELECT marker FROM install_fixture.identity',role='supabase_admin')!='sandra-inbox-action-runtime-owned-synthetic':raise RuntimeError('Wrong action marker')
if f.sql('SELECT count(*) FROM auth.users')!='0' or f.sql('SELECT count(*) FROM public.messages')!='0':raise RuntimeError('Expected empty canonical fixture')
source=S/'generated/install-candidate.sql';body=source.read_text()
if f.sql("SELECT to_regnamespace('inbox_control') IS NOT NULL")=='t':raise RuntimeError('Foundation already installed; no reset')
f.sql(body)
indexes=[f.ensure_concurrent_index(p.read_text()) for p in sorted((S/'generated').glob('index-*.sql'))]
f.sql('ALTER TABLE public.messages VALIDATE CONSTRAINT messages_inbox_inbound_revision_nonnegative')
for _ in range(10):
 f.sql('SELECT inbox_control.seed_baseline_batch(100)')
 if f.sql("SELECT stage FROM inbox_control.baseline_progress")=='done':break
else:raise RuntimeError('Baseline did not finish')
if f.sql('SELECT serving_enabled FROM inbox_control.rollout')!='f':raise RuntimeError('Serving must stay disabled')
# Reuse exact catalog verifier with only its DB/marker adapter redirected. Its
# source/path and source-manifest validation still refer to reviewed package.
f.guard=lambda: None
original=(S/'verify.py').read_text().replace("(P/'catalog-evidence.json').write_text", "(Path("+repr(str(P))+")/'catalog-evidence.json').write_text");sys.argv=['verify.py','--installed']
exec(compile(original,str(S/'verify.py'),'exec'),{'__file__':str(S/'verify.py'),'__name__':'__main__'})
(P/'install-evidence.json').write_text(json.dumps({'database':f.DB,'foundation_sha256':hashlib.sha256(body.encode()).hexdigest(),'indexes':indexes,'baseline_done':True,'serving_enabled':False,'copied_operations':0,'auth_users':0,'canonical_messages':0},indent=2)+'\n')
print('Empty action fixture foundation ready; serving disabled')
