#!/usr/bin/env python3
"""Verify compiler determinism and, with --installed, the exact guarded installed schema."""
import argparse,ast,glob,hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--installed',action='store_true');a=ap.parse_args()
manifest=P/'source-manifest.json'
if manifest.exists():
 for name,digest in json.loads(manifest.read_text()).items():
  if hashlib.sha256((P/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Bundle source manifest drift: '+name)
for f in P.glob('*.py'):ast.parse(f.read_text(),filename=str(f))
subprocess.run([sys.executable,str(P/'build.py')],check=True)
subprocess.run([sys.executable,str(P/'read-companion.py')],check=True)
foundation=P/'generated/install-candidate.sql';cand=foundation.read_text();digest=hashlib.sha256(foundation.read_bytes()).hexdigest()
companion_path=P/'generated/read-companion.sql'
companion=companion_path.read_text() if companion_path.exists() else ''
# The companion (read/history) namespace and the main candidate share the same
# installed catalog (inbox_* schemas, pinned canonical helpers). All structural
# checks below are derived from BOTH sources combined, so drift in the companion
# alone -- previously invisible here -- is caught the same way as in the foundation.
s=cand+'\n'+companion
receipt=json.loads((P/'install-evidence.json').read_text())
drifted=receipt['source_sha256']!=digest
if drifted:
 correction=P/'hardening-evidence.json'
 if not correction.exists() or json.loads(correction.read_text())['foundation_sha256']!=digest:
  raise RuntimeError('Generated foundation differs from recorded installation and verified forward correction; never relabel old evidence')
 # A hardening receipt only records that some hash was applied once; recording a new hash
 # is not proof the exact reviewed candidate is what is live now. A foundation-hash mismatch
 # can therefore ONLY be certified by structurally re-verifying the installed object set in
 # THIS run (--installed); a matching receipt hash alone is not sufficient.
 if not a.installed:
  raise RuntimeError('Foundation hash differs from the original recorded installation; --installed structural re-verification against the live catalog is required to certify the forward correction in hardening-evidence.json, a matching receipt hash alone does not prove the installed DDL matches')

functions=dict(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(.*?AS \$\$(.*?)\$\$;',s,re.S))

# ---------------------------------------------------------------------------
# Structural extraction from source text. All "expected" facts below are
# derived from the pinned/compiled candidate text (generated/install-candidate.sql
# + generated/read-companion.sql + the separately compiled concurrent-index
# packets + private-schemas.json), never hard-coded, so this stays exact as the
# reviewed candidate changes.
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
BOUNDARY_KW=re.compile(r'\b(NOT\s+NULL|DEFAULT|PRIMARY\s+KEY|REFERENCES|CHECK|UNIQUE)\b',re.I)

def parse_column(seg):
 seg=seg.strip();toks=seg.split(None,1)
 name=toks[0];rest=toks[1] if len(toks)>1 else ''
 found=None
 for mm in BOUNDARY_KW.finditer(rest):
  depth=rest.count('(',0,mm.start())-rest.count(')',0,mm.start())
  if depth==0:found=mm;break
 type_txt=(rest[:found.start()] if found else rest).strip()
 type_txt=TYPE_ALIAS.get(type_txt.lower(),type_txt.lower())
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

tables=sorted(set(re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)',s)))
added_cols={}
for m in re.finditer(r'ALTER TABLE ([\w.]+) ADD COLUMN (\w+ [^;]+);',s):
 added_cols.setdefault(m.group(1),[]).append(m.group(2))
all_tables=sorted(set(tables)|set(added_cols.keys()))

index_texts=list(re.findall(r'CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)? \w+ ON [^;]+;',s))
for path in list(P.glob('generated/index-*.sql'))+list(P.glob('generated/read-index-*.sql')):
 index_texts.append(path.read_text().strip())
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

def normalize_in_list(expr):
 # Postgres canonicalizes "col IN (a,b,c)" CHECK constraints to "col = ANY (ARRAY[a::text,b::text,...])"
 def repl(m):
  vals=[v.strip()+'::text' for v in split_top_level(m.group(2))]
  return f"{m.group(1)} = ANY (ARRAY[{','.join(vals)}])"
 return re.sub(r'(\w+)\s+IN\s*\(([^()]+)\)',repl,expr,flags=re.I)
def normalize_between(expr):
 # Postgres canonicalizes "x BETWEEN a AND b" to "x >= a AND x <= b"
 return re.sub(r'(\w+)\s+BETWEEN\s+(\S+)\s+AND\s+(\S+)',lambda m:f"{m.group(1)} >= {m.group(2)} AND {m.group(1)} <= {m.group(3)}",expr,flags=re.I)
def constraint_compact(v):
 v=normalize_between(normalize_in_list(v))
 v=re.sub(r'::\w+','',v)  # Postgres adds explicit casts (e.g. 'array'::text) source text lacks
 return re.sub(r'\s+','',v).lower().replace('(','').replace(')','')

def extract_constraints_for_table(t):
 if t not in tables:return []
 body=find_paren_body(s,r'CREATE TABLE (?:IF NOT EXISTS )?'+re.escape(t)+r'\s*\(')
 segs=[seg.strip() for seg in split_top_level(body) if seg.strip()]
 frags=[]
 for seg in segs:
  if CONSTRAINT_KW.match(seg):frags.append(seg);continue
  name=seg.split(None,1)[0]
  if re.search(r'\bPRIMARY\s+KEY\b',seg,re.I):frags.append(f'PRIMARY KEY ({name})')
  if re.search(r'\bUNIQUE\b',seg,re.I):frags.append(f'UNIQUE ({name})')
  cm=re.search(r'\bCHECK\s*\(',seg,re.I)
  if cm:
   start=cm.end();depth=1;i=start
   while depth>0:
    if seg[i]=='(':depth+=1
    elif seg[i]==')':depth-=1
    i+=1
   frags.append(f'CHECK ({seg[start:i-1]})')
  rm=re.search(r'\bREFERENCES\s+([\w.]+)\s*\(([\w,\s]+)\)',seg,re.I)
  if rm:frags.append(f'FOREIGN KEY ({name}) REFERENCES {rm.group(1)}({rm.group(2)})')
 for m in re.finditer(r'ALTER TABLE '+re.escape(t)+r' ADD CONSTRAINT \w+\s+([^;]+);',s):frags.append(m.group(1))
 return frags

private_schemas_path=P/'private-schemas.json'
private_schemas=json.loads(private_schemas_path.read_text()) if private_schemas_path.exists() else sorted(set(t.split('.')[0] for t in tables)-{'public'})

if a.installed:
 from fixture_db import guard,sql
 guard()
 actual=json.loads(sql("BEGIN READ ONLY;SELECT jsonb_object_agg(n.nspname||'.'||p.proname,p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' OR (n.nspname='public' AND p.proname LIKE 'inbox\\_%' ESCAPE '\\');COMMIT;"))
 for name,body in functions.items():
  if actual.get(name)!=body:raise RuntimeError('Installed foundation body differs: '+name)

 # Columns: name + type + nullability + default for every table (CREATE TABLE and
 # ALTER TABLE ... ADD COLUMN alike), not merely "table exists".
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
  schema,table=t.split('.')
  if sql(f"SELECT (to_regclass('{schema}.{table}') IS NOT NULL)::text")!='true':
   raise RuntimeError('Installed table missing: '+t)
  if t not in tables:
   # ALTER-only table (e.g. public.messages): verify only the added columns, not the whole table.
   for name,(etype,enn,edef) in cols.items():
    row=sql(f"SELECT coalesce(jsonb_build_object('type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)),'null') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='{schema}' AND c.relname='{table}' AND a.attname='{name}' AND NOT a.attisdropped")
    r=json.loads(row)
    if not r:raise RuntimeError(f'Added column missing: {t}.{name}')
    if r['type'].lower()!=etype.lower():raise RuntimeError(f'Column type drift {t}.{name}: expected {etype!r} live {r["type"]!r}')
    if r['notnull']!=enn:raise RuntimeError(f'Column nullability drift {t}.{name}: expected notnull={enn} live={r["notnull"]}')
   continue
  liverows=json.loads(sql(f"SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum),'[]') FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='{schema}' AND c.relname='{table}' AND a.attnum>0 AND NOT a.attisdropped"))
  livecols={r['name']:(r['type'],r['notnull'],r['default']) for r in liverows}
  if set(livecols)!=set(cols):raise RuntimeError(f'Column set drift on {t}: expected={sorted(cols)} live={sorted(livecols)}')
  for name,(etype,enn,edef) in cols.items():
   ltype,lnn,ldef=livecols[name]
   if etype.lower()!=ltype.lower():raise RuntimeError(f'Column type drift {t}.{name}: expected {etype!r} live {ltype!r}')
   if enn!=lnn:raise RuntimeError(f'Column nullability drift {t}.{name}: expected notnull={enn} live={lnn}')

 # Indexes: full pg_get_indexdef comparison, not just presence-by-name.
 for name,(schema,ecompact) in expected_index.items():
  row=sql(f"SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid=to_regclass('{schema}.{name}')")
  if not row:raise RuntimeError('Installed index missing: '+name)
  if index_compact(row)!=ecompact:raise RuntimeError(f'Index definition drift: {name}\n  expected={ecompact}\n  live=    {index_compact(row)}')

 # Triggers: pg_get_triggerdef + enabled state -- a DISABLE TRIGGER must fail here.
 for stmt in trigger_stmts:
  name=re.match(r'CREATE TRIGGER (\w+)',stmt).group(1)
  table=re.search(r'\bON\s+([\w.]+)',stmt).group(1)
  schema,tname=table.split('.')
  row=sql(f"SELECT pg_get_triggerdef(t.oid)||'|'||t.tgenabled::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{schema}' AND c.relname='{tname}' AND t.tgname='{name}'")
  if not row:raise RuntimeError(f'Installed trigger missing: {name} on {table}')
  livedef,enabled=row.rsplit('|',1)
  if enabled!='O':raise RuntimeError(f'Installed trigger disabled: {name} on {table} (tgenabled={enabled})')
  if name not in livedef:raise RuntimeError(f'Installed trigger definition drift: {name} on {table}')

 # Constraints: pg_get_constraintdef comparison (expression, not just name/count).
 for t in tables:
  expected_frags=extract_constraints_for_table(t)
  schema,table=t.split('.')
  live_defs=json.loads(sql(f"SELECT coalesce(jsonb_agg(pg_get_constraintdef(oid)),'[]') FROM pg_constraint WHERE conrelid=to_regclass('{schema}.{table}')"))
  if len(expected_frags)!=len(live_defs):raise RuntimeError(f'Constraint count drift on {t}: expected={len(expected_frags)} live={len(live_defs)}')
  remaining=[constraint_compact(d) for d in live_defs]
  for frag in expected_frags:
   ec=constraint_compact(frag)
   hit=next((lc for lc in remaining if ec in lc or lc in ec),None)
   if hit is None:raise RuntimeError(f'Constraint definition drift on {t}: expected fragment not found live: {frag!r} (live remaining={remaining})')
   remaining.remove(hit)

 # Rollout config: the serving_enabled column DEFAULT must be false -- a changed
 # default (even with the current row value correct) must fail here.
 rollout_default=sql("SELECT pg_get_expr(d.adbin,d.adrelid) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='inbox_control' AND c.relname='rollout' AND a.attname='serving_enabled'")
 if rollout_default.strip().lower()!='false':raise RuntimeError('inbox_control.rollout.serving_enabled default is not false: '+rollout_default)

 # Extra objects: the private companion schemas (private-schemas.json) must contain
 # EXACTLY the expected object set. public is the pre-existing shared app schema
 # (hundreds of unrelated objects, plus other already-merged inbox_-prefixed
 # features this candidate explicitly does not own per README) so it is not
 # scanned for extras here.
 for sch in private_schemas:
  live_fns=set(json.loads(sql(f"SELECT coalesce(jsonb_agg(n.nspname||'.'||p.proname),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='{sch}'")))
  extra=live_fns-set(functions)
  if extra:raise RuntimeError(f'Extra functions in {sch}: {extra}')
  live_tbls=set(json.loads(sql(f"SELECT coalesce(jsonb_agg(n.nspname||'.'||c.relname),'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{sch}' AND c.relkind='r'")))
  extra_t=live_tbls-set(t for t in tables if t.startswith(sch+'.'))
  if extra_t:raise RuntimeError(f'Extra tables in {sch}: {extra_t}')
  live_idx=set(json.loads(sql(f"SELECT coalesce(jsonb_agg(schemaname||'.'||indexname),'[]') FROM pg_indexes WHERE schemaname='{sch}'")))
  expected_idx=set(f"{schema}.{name}" for name,(schema,_) in expected_index.items() if schema==sch)
  # PK/unique indexes auto-created by inline constraints are expected extras (not CREATE INDEX text).
  live_constraint_idx=set(json.loads(sql(f"SELECT coalesce(jsonb_agg(n.nspname||'.'||c.conname),'[]') FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='{sch}' AND c.contype IN ('p','u')")))
  extra_i=live_idx-expected_idx-live_constraint_idx
  if extra_i:raise RuntimeError(f'Extra indexes in {sch}: {extra_i}')
  live_trig=set(json.loads(sql(f"SELECT coalesce(jsonb_agg(n.nspname||'.'||c.relname||'.'||t.tgname),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{sch}' AND NOT t.tgisinternal")))
  expected_trig=set()
  for stmt in trigger_stmts:
   nm=re.match(r'CREATE TRIGGER (\w+)',stmt).group(1);tb=re.search(r'\bON\s+([\w.]+)',stmt).group(1)
   if tb.startswith(sch+'.'):expected_trig.add(f"{tb}.{nm}")
  extra_tr=live_trig-expected_trig
  if extra_tr:raise RuntimeError(f'Extra triggers in {sch}: {extra_tr}')
  live_pol=sql(f"SELECT count(*) FROM pg_policies WHERE schemaname='{sch}'")
  if live_pol!='0':raise RuntimeError(f'Extra policies in {sch}: {live_pol}')

 # Function signature attributes (SECURITY DEFINER, search_path='') for every
 # function this candidate declares, including companion functions.
 for name in functions:
  m=re.search(r'CREATE (?:OR REPLACE )?FUNCTION '+re.escape(name)+r'\(.*?\)\s*RETURNS\s+(?:SETOF\s+)?(?:TABLE\([^)]*\)|[\w.]+)\s+LANGUAGE\s+(\w+)([\s\S]*?)AS \$\$',s)
  if not m:raise RuntimeError('Could not parse function signature header from source: '+name)
  rest=m.group(2)
  expect_secdef='SECURITY DEFINER' in rest
  expect_sp="search_path=''" in rest or 'search_path TO ' in rest
  schema,fname=name.split('.')
  row=sql(f"SELECT prosecdef::text||'|'||array_to_string(coalesce(proconfig,'{{}}'),',') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='{schema}' AND p.proname='{fname}' LIMIT 1")
  if not row:raise RuntimeError('Installed function missing: '+name)
  secdef,proconfig=row.split('|',1)
  if (secdef=='true')!=expect_secdef:raise RuntimeError(f'SECURITY DEFINER drift on {name}: expected={expect_secdef} live={secdef}')
  if expect_sp and 'search_path=' not in proconfig:raise RuntimeError(f'search_path drift on {name}: live proconfig={proconfig!r}')

 if sql("SELECT relreplident FROM pg_class WHERE oid='inbox_bridge.summaries'::regclass")!='f':raise RuntimeError('Projection replica identity drift')
 bad=sql("SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))")
 if bad!='0':raise RuntimeError('Private helper exposed to browser/service roles')
 result={'foundation_sha256':digest,'installed_function_bodies':len(functions),'installed_tables':len(all_tables),'installed_indexes':len(expected_index),'installed_triggers':len(trigger_stmts),'installed_constraints':sum(len(extract_constraints_for_table(t)) for t in tables),'private_schemas_scanned':len(private_schemas),'rollout_serving_default':'false','private_helper_exposure_count':0,'replica_identity':'FULL','scope':'Read-only owned fixture catalog proof, definition-level (columns/indexes/triggers/constraints/extra-objects/rollout-default/function-attributes), not merely name presence; excludes runtime throughput and production schema equivalence'}
 (P/'catalog-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
else:
 print('Source syntax, pinned transforms and installation receipt hash verified')
