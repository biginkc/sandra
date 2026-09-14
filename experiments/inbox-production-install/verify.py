#!/usr/bin/env python3
"""Verify compiler determinism and, with --installed, the exact guarded installed schema."""
import argparse,ast,hashlib,json,re,shutil,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--installed',action='store_true');a=ap.parse_args()
manifest=P/'source-manifest.json'
if manifest.exists():
 for name,digest in json.loads(manifest.read_text()).items():
  if hashlib.sha256((P/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Bundle source manifest drift: '+name)
for f in P.glob('*.py'):ast.parse(f.read_text(),filename=str(f))
# Wipe generated/ before regenerating: build.py and read-companion.py always fully
# rewrite every file they own from hash-verified pinned source, so a clean wipe means
# nothing here can ever read a stale or injected file left over from a prior run (an
# injected extra generated/index-08.sql, a stale generated/install-candidate.sql
# nobody regenerated, etc.) -- everything "expected" below is derived exclusively
# from what THIS run's compilers, running against the manifest-pinned source we just
# hash-checked above, just wrote.
shutil.rmtree(P/'generated',ignore_errors=True)
subprocess.run([sys.executable,str(P/'build.py')],check=True)
subprocess.run([sys.executable,str(P/'read-companion.py')],check=True)
foundation=P/'generated/install-candidate.sql';cand=foundation.read_text();digest=hashlib.sha256(foundation.read_bytes()).hexdigest()
companion_path=P/'generated/read-companion.sql'
companion=companion_path.read_text() if companion_path.exists() else ''
# The companion (read/history) namespace and the main candidate share the same
# installed catalog (inbox_* schemas, pinned canonical helpers). All structural
# checks below are derived from BOTH sources combined, so drift in the companion
# alone is caught the same way as in the foundation.
s=cand+'\n'+companion
receipt=json.loads((P/'install-evidence.json').read_text())
drifted=receipt['source_sha256']!=digest
if drifted:
 correction=P/'hardening-evidence.json'
 if not correction.exists() or json.loads(correction.read_text())['foundation_sha256']!=digest:
  raise RuntimeError('Generated foundation differs from recorded installation and verified forward correction; never relabel old evidence')
 if not a.installed:
  raise RuntimeError('Foundation hash differs from the original recorded installation; --installed structural re-verification against the live catalog is required to certify the forward correction in hardening-evidence.json, a matching receipt hash alone does not prove the installed DDL matches')

# ---------------------------------------------------------------------------
# Structural extraction from source text. Every "expected" fact below is derived
# from the pinned/compiled candidate text -- generated/install-candidate.sql and
# generated/read-companion.sql (this run's fresh output, never stale/injected --
# see the rmtree above), generated/indexes.json + generated/read-indexes.json
# (ditto: this run's fresh compiler output, never individual generated/index-*.sql
# files globbed off disk), and private-schemas.json (hash-pinned in
# source-manifest.json and checked above) -- never hard-coded.
# ---------------------------------------------------------------------------

def split_top_level(text,sep=','):
 out=[];depth=0;cur=''
 for c in text:
  if c=='(':depth+=1;cur+=c
  elif c==')':depth-=1;cur+=c
  elif c==sep and depth==0:out.append(cur);cur=''
  else:cur+=c
 if cur.strip():out.append(cur)
 return out

def find_paren_body(text,marker):
 m=re.search(marker,text)
 if not m:return None
 start=m.end();depth=1;i=start
 while depth>0:
  if text[i]=='(':depth+=1
  elif text[i]==')':depth-=1
  i+=1
 return text[start:i-1]

CONSTRAINT_KW=re.compile(r'^\s*(CHECK\b|PRIMARY\s+KEY\b|UNIQUE\b|FOREIGN\s+KEY\b|CONSTRAINT\b)',re.I)
TYPE_ALIAS={'timestamptz':'timestamp with time zone','timestamp':'timestamp without time zone','int':'integer','int4':'integer','int8':'bigint','bool':'boolean','serial':'integer'}
def norm_type(t):return TYPE_ALIAS.get(t.strip().lower(),t.strip().lower())
BOUNDARY_KW=re.compile(r'\b(NOT\s+NULL|DEFAULT|PRIMARY\s+KEY|REFERENCES|CHECK|UNIQUE)\b',re.I)

def parse_column(seg):
 seg=seg.strip();toks=seg.split(None,1)
 name=toks[0];rest=toks[1] if len(toks)>1 else ''
 found=None
 for mm in BOUNDARY_KW.finditer(rest):
  depth=rest.count('(',0,mm.start())-rest.count(')',0,mm.start())
  if depth==0:found=mm;break
 type_txt=norm_type(rest[:found.start()] if found else rest)
 notnull=bool(re.search(r'\bNOT\s+NULL\b',rest,re.I)) or bool(re.search(r'\bPRIMARY\s+KEY\b',rest,re.I))
 default=None
 dm=re.search(r'\bDEFAULT\s+',rest,re.I)
 if dm:
  start=dm.end();depth=0;i=start
  while i<len(rest):
   c=rest[i]
   if c=='(':depth+=1
   elif c==')':
    if depth==0:break
    depth-=1
   elif depth==0 and re.match(r'(NOT\s+NULL|PRIMARY\s+KEY|REFERENCES|CHECK|UNIQUE)\b',rest[i:],re.I):break
   i+=1
  default=rest[start:i].strip()
 return name,type_txt,notnull,default
def default_compact(v):
 if v is None:return None
 v=re.sub(r'::\w+(\([^)]*\))?','',v)
 return re.sub(r'\s+','',v).lower()

tables=sorted(set(re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)',s)))
added_cols={}
for m in re.finditer(r'ALTER TABLE ([\w.]+) ADD COLUMN (\w+ [^;]+);',s):
 added_cols.setdefault(m.group(1),[]).append(m.group(2))
all_tables=sorted(set(tables)|set(added_cols.keys()))
rls_tables=sorted(set(re.findall(r'ALTER TABLE ([\w.]+) ENABLE ROW LEVEL SECURITY',s)))

def load_index_manifest(name):
 path=P/'generated'/name
 return json.loads(path.read_text()) if path.exists() else []
index_texts=list(re.findall(r'CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)? \w+ ON [^;]+;',s))
index_texts+=load_index_manifest('indexes.json')+load_index_manifest('read-indexes.json')
def index_compact(value):
 v=re.sub(r'\s+','',value.replace('CREATE INDEX CONCURRENTLY','CREATE INDEX').replace('CONCURRENTLY ','').replace(' USING btree ',' ').replace('::text','')).lower()
 # pg_get_indexdef re-parenthesizes each AND/NOT operand and drops single-column
 # grouping parens -- purely a formatting difference for this codebase's pure-AND
 # WHERE clauses and single-expression index columns, so drop ALL parens for the
 # comparison. Commas/operand order/argument identity are still preserved, so a
 # genuine expression change (different function, different args, different
 # column order) still produces a text difference.
 return v.replace('(','').replace(')','')
expected_index={}
for stmt in index_texts:
 m=re.match(r'CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)? (\w+) ON ([\w.]+)',stmt)
 expected_index[m.group(1)]=(m.group(2).split('.')[0],index_compact(stmt.rstrip(';')))

trigger_stmts=re.findall(r'CREATE TRIGGER \w+[^;]+;',s,re.S)
TRIGGER_RE=re.compile(r'CREATE TRIGGER (\w+)\s+(BEFORE|AFTER|INSTEAD OF)\s+(.+?)\s+ON\s+([\w.]+)\s+FOR EACH (ROW|STATEMENT)\s+EXECUTE (?:FUNCTION|PROCEDURE)\s+([\w.]+)\(([^)]*)\)',re.I|re.S)
def parse_trigger(stmt):
 flat=re.sub(r'\s+',' ',stmt).strip().rstrip(';')
 m=TRIGGER_RE.search(flat)
 if not m:raise RuntimeError('Could not parse trigger statement: '+flat)
 name,timing,events_raw,table,roworstmt,fn,args=m.groups()
 events=set();of_cols=set()
 for part in re.split(r'\s+OR\s+',events_raw,flags=re.I):
  part=part.strip()
  om=re.match(r'UPDATE\s+OF\s+(.+)',part,re.I)
  if om:events.add('UPDATE');of_cols|={c.strip().lower() for c in om.group(1).split(',')}
  else:events.add(part.upper())
 fname=fn.lower()
 if fname.startswith('public.'):fname=fname[len('public.'):]  # pg_get_triggerdef omits the public. prefix
 return {'name':name,'timing':timing.upper(),'events':events,'of_cols':of_cols,'table':table.lower(),
  'roworstmt':roworstmt.upper(),'function':fname,'args':re.sub(r'\s+','',args).lower()}
expected_triggers={}
for stmt in trigger_stmts:
 parsed=parse_trigger(stmt)
 expected_triggers[(parsed['table'],parsed['name'])]=parsed

def normalize_in_list(expr):
 def repl(m):
  vals=[v.strip()+'::text' for v in split_top_level(m.group(2))]
  return f"{m.group(1)} = ANY (ARRAY[{','.join(vals)}])"
 return re.sub(r'(\w+)\s+IN\s*\(([^()]+)\)',repl,expr,flags=re.I)
def normalize_between(expr):
 return re.sub(r'(\w+)\s+BETWEEN\s+(\S+)\s+AND\s+(\S+)',lambda m:f"{m.group(1)} >= {m.group(2)} AND {m.group(1)} <= {m.group(3)}",expr,flags=re.I)
def constraint_compact(v):
 v=normalize_between(normalize_in_list(v))
 v=re.sub(r'::\w+','',v)
 return re.sub(r'\s+','',v).lower().replace('(','').replace(')','')

FK_RE=re.compile(r'\bREFERENCES\s+([\w.]+)\s*\(([\w,\s]+)\)(\s+ON\s+DELETE\s+\w+(?:\s+\w+)?)?(\s+ON\s+UPDATE\s+\w+(?:\s+\w+)?)?',re.I)
def extract_constraints_for_table(t):
 frags=[]
 if t in tables:
  body=find_paren_body(s,r'CREATE TABLE (?:IF NOT EXISTS )?'+re.escape(t)+r'\s*\(')
  for seg in [x.strip() for x in split_top_level(body) if x.strip()]:
   if CONSTRAINT_KW.match(seg):frags.append((seg,True));continue
   name=seg.split(None,1)[0]
   if re.search(r'\bPRIMARY\s+KEY\b',seg,re.I):frags.append((f'PRIMARY KEY ({name})',True))
   if re.search(r'\bUNIQUE\b',seg,re.I):frags.append((f'UNIQUE ({name})',True))
   cm=re.search(r'\bCHECK\s*\(',seg,re.I)
   if cm:
    start=cm.end();depth=1;i=start
    while depth>0:
     if seg[i]=='(':depth+=1
     elif seg[i]==')':depth-=1
     i+=1
    frags.append((f'CHECK ({seg[start:i-1]})',True))
   fm=FK_RE.search(seg)
   if fm:
    tail=(fm.group(3) or '')+(fm.group(4) or '')
    frags.append((f'FOREIGN KEY ({name}) REFERENCES {fm.group(1)}({fm.group(2)}){tail}',True))
 for m in re.finditer(r'ALTER TABLE '+re.escape(t)+r' ADD CONSTRAINT \w+\s+([^;]+);',s):
  clause=m.group(1)
  valid='NOT VALID' not in clause.upper()
  clause=re.sub(r'\s+NOT\s+VALID\s*$','',clause,flags=re.I)
  frags.append((clause,valid))
 return frags

private_schemas=json.loads((P/'private-schemas.json').read_text())

functions_src={}  # (schema,name) -> {'body':..., 'arg_types':[...], 'secdef':bool, 'search_path':bool}
for name in dict(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(.*?AS \$\$(.*?)\$\$;',s,re.S)):
 # A function may be CREATE FUNCTION'd once and later CREATE OR REPLACE FUNCTION'd
 # again further down (e.g. after an ADD COLUMN it now needs to reference) -- the
 # LAST definition in source order is what actually ends up installed, so take the
 # last match, not the first.
 header_matches=list(re.finditer(r'CREATE (?:OR REPLACE )?FUNCTION '+re.escape(name)+r'\((.*?)\)\s*RETURNS\s+(?:SETOF\s+)?(?:TABLE\([^)]*\)|[\w.]+)\s+LANGUAGE\s+(\w+)([\s\S]*?)AS \$\$(.*?)\$\$;',s,re.S))
 if not header_matches:raise RuntimeError('Could not parse function header: '+name)
 body_m=header_matches[-1]
 argtext,lang,rest,body=body_m.groups()
 arg_types=[]
 for arg in split_top_level(argtext):
  arg=arg.strip()
  if not arg:continue
  toks=arg.split(None,1)
  # arg forms: "name type[ DEFAULT ...]" or quoted-name "limit" integer
  typepart=toks[1] if len(toks)>1 else toks[0]
  typepart=re.split(r'\bDEFAULT\b',typepart,flags=re.I)[0].strip()
  arg_types.append(norm_type(typepart))
 schema,fname=name.split('.')
 functions_src[(schema,fname)]={'body':body,'arg_types':arg_types,
  'secdef':'SECURITY DEFINER' in rest,'search_path':("search_path=''" in rest or 'search_path TO ' in rest)}

if a.installed:
 from fixture_db import guard,sql
 guard()
 private_arr='ARRAY['+','.join("'"+x+"'" for x in private_schemas)+']::text[]'
 table_keys=sorted(set(all_tables))
 table_arr='ARRAY['+','.join("'"+t+"'" for t in table_keys)+']::text[]' if table_keys else "ARRAY[]::text[]"
 index_keys=sorted(f"{schema}.{name}" for name,(schema,_) in expected_index.items())
 index_arr='ARRAY['+','.join("'"+x+"'" for x in index_keys)+']::text[]' if index_keys else "ARRAY[]::text[]"
 trigger_keys=sorted(f"{t}.{n}" for (t,n) in expected_triggers)
 trigger_arr='ARRAY['+','.join("'"+x+"'" for x in trigger_keys)+']::text[]' if trigger_keys else "ARRAY[]::text[]"
 constraint_tables=sorted(set(tables)|{m.group(1) for m in re.finditer(r'ALTER TABLE ([\w.]+) ADD CONSTRAINT',s)})
 constraint_arr='ARRAY['+','.join("'"+t+"'" for t in constraint_tables)+']::text[]' if constraint_tables else "ARRAY[]::text[]"
 # Scope the function snapshot to schemas THIS candidate actually owns (private_schemas)
 # plus the specific public.inbox_* names it declares -- a loose 'inbox\_%' schema-name
 # wildcard would also sweep in sibling already-merged inbox_-prefixed feature areas
 # (inbox_action_api, inbox_operation_domain, inbox_operations) that share this fixture
 # database but are not part of this candidate at all (confirmed empirically: those
 # schemas exist here from separate, already-reviewed experiments).
 public_fn_names=sorted(fname for (schema,fname) in functions_src if schema=='public')
 public_fn_arr='ARRAY['+','.join("'"+x+"'" for x in public_fn_names)+']::text[]' if public_fn_names else "ARRAY[]::text[]"
 rls_arr='ARRAY['+','.join("'"+t+"'" for t in rls_tables)+']::text[]' if rls_tables else "ARRAY[]::text[]"

 # ONE snapshot, ONE transaction: every catalog read below observes the same
 # REPEATABLE READ view, so a coordinated repair/re-drift straddling two reads
 # cannot produce a certificate for a materially-drifted final catalog (no
 # separate connections/statements are used for any check past this point).
 snapshot_sql=f"""
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SELECT jsonb_build_object(
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid))),'[]')
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE (n.nspname||'.'||c.relname)=ANY({table_arr}) AND a.attnum>0 AND NOT a.attisdropped),
 'rls',(SELECT coalesce(jsonb_object_agg(n.nspname||'.'||c.relname,c.relrowsecurity),'{{}}')
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname||'.'||c.relname)=ANY({rls_arr}) AND c.relkind='r'),
 'indexes',(SELECT coalesce(jsonb_object_agg(n.nspname||'.'||ic.relname,pg_get_indexdef(i.indexrelid)),'{{}}')
   FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace n ON n.oid=ic.relnamespace
   WHERE (n.nspname||'.'||ic.relname)=ANY({index_arr})),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',n.nspname||'.'||c.relname||'.'||t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled::text)),'[]')
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND (n.nspname||'.'||c.relname||'.'||t.tgname)=ANY({trigger_arr})),
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',n.nspname||'.'||c.relname,'def',pg_get_constraintdef(co.oid),'valid',co.convalidated)),'[]')
   FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE (n.nspname||'.'||c.relname)=ANY({constraint_arr})),
 'rollout_default',(SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='inbox_control' AND c.relname='rollout' AND a.attname='serving_enabled'),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'args',pg_get_function_identity_arguments(p.oid),'prosecdef',p.prosecdef,'search_path',(SELECT x FROM unnest(coalesce(p.proconfig,'{{}}'::text[])) x WHERE x LIKE 'search_path=%'),'prosrc',p.prosrc)),'[]')
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname=ANY({private_arr}) OR (n.nspname='public' AND p.proname=ANY({public_fn_arr}))),
 'extra_relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind)),'[]')
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY({private_arr}) AND c.relkind IN ('r','v','m','S')),
 'extra_types',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.typname)),'[]')
   FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=ANY({private_arr}) AND t.typtype IN ('d','e','r','c') AND t.typname NOT IN (SELECT relname FROM pg_class c2 JOIN pg_namespace n2 ON n2.oid=c2.relnamespace WHERE n2.nspname=n.nspname)),
 'extra_indexes',(SELECT coalesce(jsonb_agg(schemaname||'.'||indexname),'[]') FROM pg_indexes WHERE schemaname=ANY({private_arr})),
 'extra_triggers',(SELECT coalesce(jsonb_agg(n.nspname||'.'||c.relname||'.'||t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY({private_arr}) AND NOT t.tgisinternal),
 'extra_policies',(SELECT coalesce(jsonb_agg(schemaname||'.'||tablename||'.'||policyname),'[]') FROM pg_policies WHERE schemaname=ANY({private_arr})),
 'constraint_indexes',(SELECT coalesce(jsonb_agg(n.nspname||'.'||c.conname),'[]') FROM pg_constraint c JOIN pg_class t2 ON t2.oid=c.conrelid JOIN pg_namespace n ON n.oid=t2.relnamespace WHERE n.nspname=ANY({private_arr}) AND c.contype IN ('p','u')),
 'replica_identity',(SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass),
 'privilege_exposure',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE')))
);
COMMIT;
"""
 snap=json.loads(sql(snapshot_sql))

 # Function bodies + attributes (name+signature identity, not name-only).
 live_fn_by_key={}  # (schema,name) -> list of live rows (>1 = conflicting overload)
 for row in snap['functions']:
  live_fn_by_key.setdefault((row['schema'],row['name']),[]).append(row)
 for (schema,fname),exp in functions_src.items():
  rows=live_fn_by_key.get((schema,fname),[])
  if not rows:raise RuntimeError(f'Installed function missing: {schema}.{fname}')
  if len(rows)>1:raise RuntimeError(f'Conflicting overload(s) installed for {schema}.{fname}: {[r["args"] for r in rows]}')
  row=rows[0]
  live_arg_types=[]
  if row['args']:
   for arg in row['args'].split(','):
    toks=arg.strip().split(None,1)
    live_arg_types.append(norm_type(toks[1] if len(toks)>1 else toks[0]))
  if live_arg_types!=exp['arg_types']:raise RuntimeError(f'Function signature drift {schema}.{fname}: expected={exp["arg_types"]} live={live_arg_types}')
  if row['prosrc']!=exp['body']:raise RuntimeError(f'Installed foundation body differs: {schema}.{fname}')
  if row['prosecdef']!=exp['secdef']:raise RuntimeError(f'SECURITY DEFINER drift on {schema}.{fname}: expected={exp["secdef"]} live={row["prosecdef"]}')
  if exp['search_path'] and row['search_path'] not in ('search_path=','search_path=""'):raise RuntimeError(f"search_path drift on {schema}.{fname}: expected empty search_path, live={row['search_path']!r}")
 # any extra installed function (in scope) not declared by this candidate at all
 extra_fn=set(live_fn_by_key)-set(functions_src)
 if extra_fn:raise RuntimeError('Extra installed functions: '+str(sorted(extra_fn)))

 # Columns: name + type + nullability + DEFAULT (compared, not merely extracted).
 live_cols={}
 for row in snap['columns']:
  live_cols.setdefault(f"{row['schema']}.{row['table']}",{})[row['column']]=(row['type'],row['notnull'],row['default'])
 for t in all_tables:
  cols={}
  if t in tables:
   body=find_paren_body(s,r'CREATE TABLE (?:IF NOT EXISTS )?'+re.escape(t)+r'\s*\(')
   if body is None:raise RuntimeError('Could not locate CREATE TABLE body in source: '+t)
   for seg in [x.strip() for x in split_top_level(body) if x.strip()]:
    if CONSTRAINT_KW.match(seg):continue
    name,type_txt,notnull,default=parse_column(seg)
    cols[name]=(type_txt,notnull,default)
  for coldef in added_cols.get(t,[]):
   name,type_txt,notnull,default=parse_column(coldef)
   cols[name]=(type_txt,notnull,default)
  lc=live_cols.get(t)
  if lc is None:raise RuntimeError('Installed table missing: '+t)
  if t in tables and set(lc)!=set(cols):raise RuntimeError(f'Column set drift on {t}: expected={sorted(cols)} live={sorted(lc)}')
  for name,(etype,enn,edef) in cols.items():
   if name not in lc:raise RuntimeError(f'Added column missing: {t}.{name}')
   ltype,lnn,ldef=lc[name]
   if etype.lower()!=ltype.lower():raise RuntimeError(f'Column type drift {t}.{name}: expected {etype!r} live {ltype!r}')
   if enn!=lnn:raise RuntimeError(f'Column nullability drift {t}.{name}: expected notnull={enn} live={lnn}')
   if default_compact(edef)!=default_compact(ldef):raise RuntimeError(f'Column default drift {t}.{name}: expected {edef!r} live {ldef!r}')

 # RLS: every ENABLE ROW LEVEL SECURITY table must still have it enabled live.
 for t in rls_tables:
  if t not in snap['rls']:raise RuntimeError('RLS table missing from snapshot: '+t)
  if snap['rls'][t] is not True:raise RuntimeError('Row level security disabled on installed table: '+t)

 # Indexes: full pg_get_indexdef comparison.
 for name,(schema,ecompact) in expected_index.items():
  key=f"{schema}.{name}"
  livedef=snap['indexes'].get(key)
  if not livedef:raise RuntimeError('Installed index missing: '+name)
  if index_compact(livedef)!=ecompact:raise RuntimeError(f'Index definition drift: {name}\n  expected={ecompact}\n  live=    {index_compact(livedef)}')

 # Triggers: full pg_get_triggerdef (timing/events/OF columns/table/function/args)
 # compared component-wise (Postgres reorders the OR-separated event list into its
 # own canonical order, so a raw-text diff would false-positive on that alone) --
 # plus tgenabled. A retargeted/re-timed/disabled trigger now fails here.
 live_trig={row['key']:row for row in snap['triggers']}
 for (table,name),exp in expected_triggers.items():
  key=f"{table}.{name}"
  row=live_trig.get(key)
  if not row:raise RuntimeError(f'Installed trigger missing: {name} on {table}')
  if row['enabled']!='O':raise RuntimeError(f'Installed trigger disabled: {name} on {table} (tgenabled={row["enabled"]})')
  live=parse_trigger(row['def']+';')
  for field in ('timing','events','of_cols','table','roworstmt','function','args'):
   if live[field]!=exp[field]:raise RuntimeError(f'Trigger definition drift on {name} ({table}), field {field}: expected={exp[field]!r} live={live[field]!r}\n  live def={row["def"]}')

 # Constraints: exact normalized pg_get_constraintdef equality (not substring
 # containment -- a WEAKENED live CHECK that happens to be a substring of the
 # expected text must fail), plus NOT VALID / convalidated and FK ON DELETE/UPDATE.
 # Owned tables (this candidate's own CREATE TABLE) must match the FULL constraint
 # set exactly; foreign ALTER-only tables (e.g. public.messages, owned by the base
 # app schema with many pre-existing constraints of its own) are checked only for
 # the specific constraint(s) this candidate itself adds, not an exact total count.
 live_cons={}
 for row in snap['constraints']:
  live_cons.setdefault(row['table'],[]).append(row)
 for t in constraint_tables:
  expected_frags=extract_constraints_for_table(t)
  rows=live_cons.get(t,[])
  if t in tables and len(expected_frags)!=len(rows):raise RuntimeError(f'Constraint count drift on {t}: expected={len(expected_frags)} live={len(rows)}\n  expected={expected_frags}\n  live={rows}')
  remaining=list(rows)
  for frag,valid in expected_frags:
   # NOT VALID is a transient install-time property (e.g. the deferred
   # inbound-revision constraint is intentionally validated after foundation
   # locks release, per README) so it is not compared here; the constraint
   # EXPRESSION/definition itself (exact match, not substring) is what matters.
   ec=constraint_compact(frag)
   hit=next((r for r in remaining if constraint_compact(r['def'])==ec),None)
   if hit is None:raise RuntimeError(f'Constraint definition drift on {t}: expected fragment not found live (exact match required): {frag!r} (live remaining={remaining})')
   remaining.remove(hit)

 # Rollout config: the serving_enabled column DEFAULT must be false -- a changed
 # default (even with the current row value correct) fails here. Derived from the
 # candidate's own CREATE TABLE text (never hard-coded): D7/D9's flags-default-OFF
 # ruling is what the source itself declares (`serving_enabled boolean NOT NULL
 # DEFAULT false`), so the expectation below is read out of `s`, not typed in.
 rollout_body=find_paren_body(s,r'CREATE TABLE (?:IF NOT EXISTS )?inbox_control\.rollout\s*\(')
 rollout_expected=None
 for seg in split_top_level(rollout_body):
  seg=seg.strip()
  if seg.split(None,1)[0]=='serving_enabled':
   _,_,_,rollout_expected=parse_column(seg)
 if rollout_expected is None:raise RuntimeError('Could not find serving_enabled column default in source')
 if default_compact(snap['rollout_default'])!=default_compact(rollout_expected):
  raise RuntimeError(f"inbox_control.rollout.serving_enabled default drift: expected={rollout_expected!r} live={snap['rollout_default']!r}")

 # Extra objects: the private companion schemas (private-schemas.json) must
 # contain EXACTLY the expected object set, across ALL relevant object kinds --
 # tables, views, materialized views, sequences, types/domains, functions
 # (by full signature identity, above), triggers, indexes, policies. public is
 # the pre-existing shared app schema (hundreds of unrelated objects, plus other
 # already-merged inbox_-prefixed features this candidate explicitly does not
 # own per README) so it is deliberately NOT scanned for extras here.
 expected_relations={t for t in tables}
 live_relations={f"{r['schema']}.{r['name']}":r['kind'] for r in snap['extra_relations']}
 extra_rel=set(live_relations)-expected_relations
 if extra_rel:raise RuntimeError(f'Extra relations (table/view/matview/sequence) in private schemas: { {k:live_relations[k] for k in extra_rel} }')
 if snap['extra_types']:raise RuntimeError('Extra types/domains in private schemas: '+str(snap['extra_types']))
 expected_idx_full=set(f"{schema}.{name}" for name,(schema,_) in expected_index.items() if schema in private_schemas)
 live_idx_full=set(snap['extra_indexes'])
 constraint_idx=set(snap['constraint_indexes'])
 extra_idx=live_idx_full-expected_idx_full-constraint_idx
 if extra_idx:raise RuntimeError('Extra indexes in private schemas: '+str(sorted(extra_idx)))
 expected_trig_full=set(f"{t}.{n}" for (t,n) in expected_triggers if t.split('.')[0] in private_schemas)
 live_trig_full=set(snap['extra_triggers'])
 extra_trig=live_trig_full-expected_trig_full
 if extra_trig:raise RuntimeError('Extra triggers in private schemas: '+str(sorted(extra_trig)))
 if snap['extra_policies']:raise RuntimeError('Extra policies in private schemas: '+str(snap['extra_policies']))

 if snap['replica_identity']!='f':raise RuntimeError('Projection replica identity drift')
 if snap['privilege_exposure']!=0:raise RuntimeError('Private helper exposed to browser/service roles')
 result={'foundation_sha256':digest,'installed_function_bodies':len(functions_src),'installed_tables':len(all_tables),'installed_indexes':len(expected_index),'installed_triggers':len(expected_triggers),'installed_constraints':sum(len(extract_constraints_for_table(t)) for t in constraint_tables),'installed_rls_tables':len(rls_tables),'private_schemas_scanned':len(private_schemas),'rollout_serving_default':rollout_expected,'private_helper_exposure_count':0,'replica_identity':'FULL','snapshot_isolation':'REPEATABLE READ, READ ONLY, single transaction','scope':'Read-only owned fixture catalog proof, definition-level (columns incl. defaults/RLS/indexes/trigger full defs/constraints incl. FK actions/extra-objects across all kinds/rollout-default/function signature+search_path) taken from one consistent snapshot, not merely name presence; excludes runtime throughput and production schema equivalence'}
 (P/'catalog-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
else:
 print('Source syntax, pinned transforms and installation receipt hash verified')
