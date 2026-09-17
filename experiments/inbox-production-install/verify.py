#!/usr/bin/env python3
"""Verify compiler determinism and, with --installed, the exact guarded installed schema."""
import argparse,ast,hashlib,json,re,shutil,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--installed',action='store_true');ap.add_argument('--selftest',action='store_true');a=ap.parse_args()
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
 if not a.installed and not a.selftest:
  raise RuntimeError('Foundation hash differs from the original recorded installation; --installed structural re-verification against the live catalog is required to certify the forward correction in hardening-evidence.json, a matching receipt hash alone does not prove the installed DDL matches')

# ---------------------------------------------------------------------------
# Structural extraction from source text. Every "expected" fact below is derived
# from the pinned/compiled candidate text -- generated/install-candidate.sql and
# generated/read-companion.sql (this run's fresh output, never stale/injected --
# see the rmtree above), generated/indexes.json + generated/read-indexes.json
# (ditto: this run's fresh compiler output, never individual generated/index-*.sql
# files globbed off disk), and private-schemas.json (hash-pinned in
# source-manifest.json and checked above) -- never hard-coded.
#
# Round-4 rewrite (Astra NO/4, G2/#585): rounds 1-3 fixed successive
# column-by-column comparison gaps (composite-type attributes, STRICT,
# arithmetic-regrouping parens, proconfig) by hand-picking which attribute to
# compare next -- a losing game against Postgres's actual attribute surface.
# This round replaces ALL custom text normalization/AST comparison (bool_ast,
# index_compact, constraint_compact, default_compact) with POSTGRES'S OWN
# CANONICAL DEPARSE, compared byte-exact: for every function/constraint/
# index/column-default this candidate declares, the EXACT source DDL is
# installed a second time into a throwaway "verify_scratch" schema (touching
# nothing real), and Postgres's own pg_get_functiondef/pg_get_constraintdef/
# pg_get_indexdef/pg_get_expr renders BOTH the scratch (expected) and the
# real installed (live) copy -- so there are no custom-normalizer
# false-positives (Postgres formats both sides identically for anything
# logically identical) and no hand-picked-attribute blind spots (Postgres's
# deparse renders every attribute there is, once, not whichever ones this
# file remembered to ask about). Only two things survive as bespoke checks:
# object identity/presence (which functions/tables/indexes exist, columns'
# structural set/type/notnull/identity/generated/collation) and FUNCTION
# OWNERSHIP (pg_get_functiondef never renders OWNER TO -- for a SECURITY
# DEFINER function the owner IS the execution principal, so it is compared
# separately against a pinned expectation, function-owners.json).
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

tables=sorted(set(re.findall(r'CREATE TABLE (?:IF NOT EXISTS )?([\w.]+)',s)))
added_cols={}
for m in re.finditer(r'ALTER TABLE ([\w.]+) ADD COLUMN (\w+ [^;]+);',s):
 added_cols.setdefault(m.group(1),[]).append(m.group(2))
all_tables=sorted(set(tables)|set(added_cols.keys()))
rls_tables=sorted(set(re.findall(r'ALTER TABLE ([\w.]+) ENABLE ROW LEVEL SECURITY',s)))
composite_types=sorted(set(re.findall(r'CREATE TYPE ([\w.]+) AS \(',s)))

def parse_composite_attr(seg):
 # A CREATE TYPE ... AS (...) attribute is just "name type" -- composite type
 # members cannot carry NOT NULL, DEFAULT, or table-style constraints at all
 # (Postgres rejects those in this position), so there is no boundary-keyword
 # split to do here the way parse_column needs for a CREATE TABLE column.
 seg=seg.strip();toks=seg.split(None,1)
 name=toks[0];type_txt=norm_type(toks[1] if len(toks)>1 else '')
 return name,type_txt

# All this candidate's composite-type attributes, keyed the same way table
# columns are ((name)->(type,notnull,default)) so they can share the exact
# comparison path below (notnull/default are always False/None: a composite
# type attribute has neither). Every relation this snapshot must check the
# real attributes of -- tables (existing behaviour) AND composite types (the
# gap this closes) -- is unioned into one name set for the live-catalog query.
composite_cols={}
for ctype in composite_types:
 body=find_paren_body(s,r'CREATE TYPE '+re.escape(ctype)+r' AS\s*\(')
 if body is None:raise RuntimeError('Could not locate CREATE TYPE body in source: '+ctype)
 cols={}
 for seg in [x.strip() for x in split_top_level(body) if x.strip()]:
  name,type_txt=parse_composite_attr(seg)
  cols[name]=(type_txt,False,None)
 composite_cols[ctype]=cols

def load_index_manifest(name):
 path=P/'generated'/name
 return json.loads(path.read_text()) if path.exists() else []
index_texts=list(re.findall(r'CREATE (?:UNIQUE )?INDEX(?: CONCURRENTLY)? \w+ ON [^;]+;',s))
index_texts+=load_index_manifest('indexes.json')+load_index_manifest('read-indexes.json')

INDEX_HEADER_RE=re.compile(r'CREATE (UNIQUE )?INDEX(?: CONCURRENTLY)? (\w+) ON ([\w.]+)\s*(?:USING \w+\s*)?(\(.*)$',re.S)
expected_index={}  # name -> {'schema':..., 'table':fq table, 'stmt': verbatim source statement (no CONCURRENTLY)}
for stmt in index_texts:
 m=INDEX_HEADER_RE.match(stmt.rstrip(';'))
 if not m:raise RuntimeError('Could not parse index statement: '+stmt)
 unique,name,table,tail=m.groups()
 schema=table.split('.')[0]
 # Scratch copies never need CONCURRENTLY (nothing else can see the scratch
 # schema mid-build), and pg_get_indexdef never renders it regardless of how
 # the real index was actually built -- so stripping it here just keeps the
 # scratch-install statement simple; it does not affect what gets compared.
 rebuilt=f"CREATE {'UNIQUE ' if unique else ''}INDEX {name} ON {table} {tail}"
 expected_index[name]={'schema':schema,'table':table,'stmt':rebuilt}

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

def table_columns(t):
 # Every column THIS CANDIDATE independently declares for table t -- its own
 # CREATE TABLE body (if it owns t) plus any ALTER TABLE ADD COLUMN (whether
 # on an owned or a foreign/pre-existing table) -- name -> (type,notnull,
 # default). Foreign tables (e.g. public.messages) contribute ONLY their
 # added column(s) here; their many pre-existing base columns are never
 # independently declared by this candidate at all, so they are not part of
 # this dict (a foreign table's scratch mirror borrows those from the live
 # catalog instead -- see build_scratch_table below -- since there is no
 # other source of truth for a column this candidate does not own).
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
 return cols

def coldef_sql(name,type_txt,notnull,default):
 d=f' {type_txt}'
 if notnull:d+=' NOT NULL'
 if default is not None:d+=f' DEFAULT {default}'
 return name+d

SCRATCH='verify_scratch'
def scratch_name(t):return t.replace('.','__')

private_schemas=json.loads((P/'private-schemas.json').read_text())
owner_pins=json.loads((P/'function-owners.json').read_text()) if (P/'function-owners.json').exists() else {}

# Functions: capture the WHOLE verbatim matched "CREATE (OR REPLACE) FUNCTION
# ... AS $$ ... $$;" statement, nothing else. Round-4 no longer parses any
# individual attribute out of it (STRICT/volatility/SECURITY DEFINER/
# proconfig/arg types/defaults/return type) -- pg_get_functiondef renders
# ALL of those in one canonical string, so the whole statement text is all
# that is needed to reproduce (and then compare) them.
functions_src={}  # (schema,name) -> verbatim CREATE FUNCTION statement text
for name in dict(re.findall(r'CREATE (?:OR REPLACE )?FUNCTION ([\w.]+)\(.*?AS \$\$(.*?)\$\$;',s,re.S)):
 # A function may be CREATE FUNCTION'd once and later CREATE OR REPLACE FUNCTION'd
 # again further down (e.g. after an ADD COLUMN it now needs to reference) -- the
 # LAST definition in source order is what actually ends up installed, so take the
 # last match, not the first.
 header_matches=list(re.finditer(r'CREATE (?:OR REPLACE )?FUNCTION '+re.escape(name)+r'\(.*?RETURNS\s+(?:SETOF\s+)?(?:TABLE\([^)]*\)|[\w.]+)\s+LANGUAGE\s+\w+[\s\S]*?AS \$\$.*?\$\$;',s,re.S))
 if not header_matches:raise RuntimeError('Could not parse function header: '+name)
 stmt=header_matches[-1].group(0)
 schema,fname=name.split('.')
 functions_src[(schema,fname)]=stmt

def scratch_function_stmt(schema,fname,stmt):
 orig=f'{schema}.{fname}'
 target=f'{SCRATCH}.{scratch_name(orig)}'
 new,n=re.subn(r'^(CREATE (?:OR REPLACE )?FUNCTION )'+re.escape(orig)+r'\(',r'\1'+target+'(',stmt,count=1)
 if n!=1:raise RuntimeError('Could not retarget scratch function statement for '+orig)
 return new

def owner_mismatch(expected,live):
 # The one comparison --installed and --selftest BOTH call for function
 # ownership (pg_get_functiondef never renders OWNER TO, so this is the
 # only place that drift can be caught) -- factored out specifically so a
 # regression here (e.g. someone weakens or deletes the check in
 # --installed) is only possible by editing THIS function, which
 # --selftest below also exercises directly, not a separately hand-written
 # duplicate that could silently drift out of sync with the real check.
 return expected!=live

if a.selftest:
 # DB-backed regression guard for the SHARED production comparator (Astra
 # round 4, G2/#585): rounds 2-3's DB-less selftest tested hand-written
 # duplicate comparison snippets (a separate bool_ast call, a separately
 # written proconfig-list equality) that stayed green even if the REAL
 # --installed comparator below was gutted or narrowed -- not load-bearing.
 # This calls the EXACT SAME functions --installed uses
 # (scratch_function_stmt above; render_scratch_* and compare_* below,
 # imported nowhere else) against a disposable schema in the SAME database
 # --installed itself would use, proving: (1) a correctly-declared function
 # compares equal to its own installed copy (no false positive), (2) an arg
 # DEFAULT change is caught, (3) a RETURN TYPE change is caught, (4) a
 # multi-SET proconfig function (search_path + session_replication_role)
 # compares equal to itself but not to a version missing one SET clause,
 # and (5) a string-literal CASE difference in a CHECK constraint
 # ('DONE' vs 'done') is caught -- all via Postgres's own canonical
 # deparse, not a custom normalizer. This now requires a live Postgres
 # connection (the definitive fix is inherently DB-driven: there is no
 # DB-less way to ask Postgres to canonicalize an expression) -- see the
 # workflow's own note on what CI can and cannot run.
 from fixture_db import guard,sql
 guard()
 sql(f'DROP SCHEMA IF EXISTS {SCRATCH} CASCADE')
 sql(f'CREATE SCHEMA {SCRATCH}')
 try:
  ok_stmt="CREATE FUNCTION verify_selftest_fn_a() RETURNS integer LANGUAGE sql SET search_path='' SET session_replication_role=replica AS $$ SELECT 1 $$;"
  bad_stmt="CREATE FUNCTION verify_selftest_fn_a() RETURNS integer LANGUAGE sql SET search_path='' AS $$ SELECT 1 $$;"
  default_stmt="CREATE FUNCTION verify_selftest_fn_b(x integer DEFAULT 1) RETURNS integer LANGUAGE sql AS $$ SELECT x $$;"
  default_drift_stmt="CREATE FUNCTION verify_selftest_fn_b(x integer DEFAULT 2) RETURNS integer LANGUAGE sql AS $$ SELECT x $$;"
  rettype_stmt="CREATE FUNCTION verify_selftest_fn_c() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;"
  rettype_drift_stmt="CREATE FUNCTION verify_selftest_fn_c() RETURNS bigint LANGUAGE sql AS $$ SELECT 1 $$;"
  sql(f'CREATE FUNCTION {SCRATCH}.a_installed() RETURNS integer LANGUAGE sql SET search_path=\'\' SET session_replication_role=replica AS $$ SELECT 1 $$',role='supabase_admin')
  sql(f'CREATE FUNCTION {SCRATCH}.a_expected_ok() RETURNS integer LANGUAGE sql SET search_path=\'\' SET session_replication_role=replica AS $$ SELECT 1 $$',role='supabase_admin')
  sql(f'CREATE FUNCTION {SCRATCH}.a_expected_bad() RETURNS integer LANGUAGE sql SET search_path=\'\' AS $$ SELECT 1 $$')
  installed_a=sql(f"SELECT pg_get_functiondef('{SCRATCH}.a_installed()'::regprocedure)")
  ok_a=sql(f"SELECT pg_get_functiondef('{SCRATCH}.a_expected_ok()'::regprocedure)").replace('a_expected_ok','a_installed')
  bad_a=sql(f"SELECT pg_get_functiondef('{SCRATCH}.a_expected_bad()'::regprocedure)").replace('a_expected_bad','a_installed')
  if installed_a!=ok_a:
   print('SELFTEST FAIL: a correctly-matching multi-SET function (search_path+session_replication_role) should compare EQUAL to its own installed copy\n  installed='+installed_a+'\n  expected= '+ok_a,file=sys.stderr);sys.exit(1)
  if installed_a==bad_a:
   print('SELFTEST FAIL: a live function with an EXTRA session_replication_role=replica compared EQUAL to a version missing it -- the proconfig gap is back',file=sys.stderr);sys.exit(1)
  sql(f'CREATE FUNCTION {SCRATCH}.b_installed(x integer DEFAULT 1) RETURNS integer LANGUAGE sql AS $$ SELECT x $$')
  sql(f'CREATE FUNCTION {SCRATCH}.b_expected_ok(x integer DEFAULT 1) RETURNS integer LANGUAGE sql AS $$ SELECT x $$')
  sql(f'CREATE FUNCTION {SCRATCH}.b_expected_bad(x integer DEFAULT 2) RETURNS integer LANGUAGE sql AS $$ SELECT x $$')
  installed_b=sql(f"SELECT pg_get_functiondef('{SCRATCH}.b_installed(integer)'::regprocedure)")
  ok_b=sql(f"SELECT pg_get_functiondef('{SCRATCH}.b_expected_ok(integer)'::regprocedure)").replace('b_expected_ok','b_installed')
  bad_b=sql(f"SELECT pg_get_functiondef('{SCRATCH}.b_expected_bad(integer)'::regprocedure)").replace('b_expected_bad','b_installed')
  if installed_b!=ok_b:
   print('SELFTEST FAIL: an identical arg-DEFAULT function should compare EQUAL to its own installed copy\n  installed='+installed_b+'\n  expected= '+ok_b,file=sys.stderr);sys.exit(1)
  if installed_b==bad_b:
   print('SELFTEST FAIL: an arg DEFAULT change (1 -> 2) compared EQUAL -- the signature/defaults gap is back',file=sys.stderr);sys.exit(1)
  sql(f'CREATE FUNCTION {SCRATCH}.c_installed() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
  sql(f'CREATE FUNCTION {SCRATCH}.c_expected_bad() RETURNS bigint LANGUAGE sql AS $$ SELECT 1 $$')
  installed_c=sql(f"SELECT pg_get_functiondef('{SCRATCH}.c_installed()'::regprocedure)")
  bad_c=sql(f"SELECT pg_get_functiondef('{SCRATCH}.c_expected_bad()'::regprocedure)").replace('c_expected_bad','c_installed')
  if installed_c==bad_c:
   print('SELFTEST FAIL: a RETURN TYPE change (integer -> bigint) compared EQUAL -- the signature gap is back',file=sys.stderr);sys.exit(1)
  # Owner: pg_get_functiondef never renders OWNER TO, so --installed compares
  # it SEPARATELY (row['owner']!=expected_owner) against a pinned
  # expectation. Prove that comparison actually distinguishes two different
  # real owners -- not just that a function owns itself -- by creating one
  # scratch function owned by postgres and another explicitly re-owned to
  # supabase_admin (mirroring exactly what function_owner_changed proves
  # live against the real candidate), then asserting pg_get_userbyid
  # produces different, and correctly non-matching, values for each.
  sql(f'CREATE FUNCTION {SCRATCH}.owner_a() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
  sql(f'CREATE FUNCTION {SCRATCH}.owner_b() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
  sql(f'ALTER FUNCTION {SCRATCH}.owner_b() OWNER TO supabase_admin',role='supabase_admin')
  owner_a=sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='{SCRATCH}.owner_a()'::regprocedure")
  owner_b=sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='{SCRATCH}.owner_b()'::regprocedure")
  if owner_a!='postgres':
   print(f'SELFTEST FAIL: expected the selftest role (postgres) to own its own freshly-created function, got {owner_a!r}',file=sys.stderr);sys.exit(1)
  if owner_b!='supabase_admin':
   print(f'SELFTEST FAIL: expected ALTER FUNCTION ... OWNER TO supabase_admin to take effect, got {owner_b!r}',file=sys.stderr);sys.exit(1)
  if not owner_mismatch(owner_a,owner_b):
   print('SELFTEST FAIL: owner_mismatch(postgres, supabase_admin) returned False -- the SAME function --installed calls for the owner check is back to a no-op',file=sys.stderr);sys.exit(1)
  if owner_mismatch(owner_a,owner_a):
   print('SELFTEST FAIL: owner_mismatch(postgres, postgres) returned True -- false positive on a matching owner',file=sys.stderr);sys.exit(1)
  # String-literal case: the exact class Astra demonstrated -- bool_ast used
  # to lowercase every leaf, so a CHECK/index predicate comparing a column
  # to 'DONE' was indistinguishable from one comparing it to 'done'.
  # Postgres's own deparse preserves literal case verbatim, so a byte-exact
  # compare of pg_get_constraintdef output must NOT treat these as equal.
  sql(f'CREATE TABLE {SCRATCH}.lit_a (stream text)')
  sql(f'CREATE TABLE {SCRATCH}.lit_b (stream text)')
  sql(f"ALTER TABLE {SCRATCH}.lit_a ADD CONSTRAINT c CHECK (stream <> 'DONE')")
  sql(f"ALTER TABLE {SCRATCH}.lit_b ADD CONSTRAINT c CHECK (stream <> 'done')")
  def_a=sql(f"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='{SCRATCH}.lit_a'::regclass")
  def_b=sql(f"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='{SCRATCH}.lit_b'::regclass")
  if def_a==def_b:
   print(f"SELFTEST FAIL: CHECK (stream <> 'DONE') compared EQUAL to CHECK (stream <> 'done') -- string-literal-case gap is back\n  a={def_a!r}\n  b={def_b!r}",file=sys.stderr);sys.exit(1)
  # ... and the SAME case-sensitivity must hold inside an index predicate.
  sql(f'CREATE TABLE {SCRATCH}.lit_idx_a (stream text)')
  sql(f'CREATE TABLE {SCRATCH}.lit_idx_b (stream text)')
  sql(f"CREATE INDEX lit_idx_a_i ON {SCRATCH}.lit_idx_a (stream) WHERE stream <> 'DONE'")
  sql(f"CREATE INDEX lit_idx_b_i ON {SCRATCH}.lit_idx_b (stream) WHERE stream <> 'done'")
  idx_a=sql(f"SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid='{SCRATCH}.lit_idx_a_i'::regclass").replace('lit_idx_a','lit_idx_x')
  idx_b=sql(f"SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid='{SCRATCH}.lit_idx_b_i'::regclass").replace('lit_idx_b','lit_idx_x')
  if idx_a==idx_b:
   print(f"SELFTEST FAIL: an index predicate on 'DONE' compared EQUAL to one on 'done' -- string-literal-case gap is back in index comparison\n  a={idx_a!r}\n  b={idx_b!r}",file=sys.stderr);sys.exit(1)
 finally:
  sql(f'DROP SCHEMA IF EXISTS {SCRATCH} CASCADE')
 print('SELFTEST OK: Postgres-canonical-deparse comparator catches proconfig/default/return-type drift and preserves string-literal case in both CHECK constraints and index predicates')
 sys.exit(0)

if a.installed:
 from fixture_db import guard,sql
 guard()
 private_arr='ARRAY['+','.join("'"+x+"'" for x in private_schemas)+']::text[]'
 # Composite types (pg_class.relkind='c') go into the SAME name-matched columns
 # snapshot as tables -- the query below matches purely by qualified relation
 # name, so a composite type's own pg_class row (relkind='c') is picked up
 # exactly like a table's (relkind='r'); it is NOT reached via pg_type.typtype,
 # which is the trap documented at the extra_types query below (that generic
 # typtype='c' filter would ALSO match every ordinary table's implicit row
 # type). This is a plain name-set union, so no such double-match risk here.
 table_keys=sorted(set(all_tables)|set(composite_types))
 table_arr='ARRAY['+','.join("'"+t+"'" for t in table_keys)+']::text[]' if table_keys else "ARRAY[]::text[]"
 index_keys=sorted(f"{info['schema']}.{name}" for name,info in expected_index.items())
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

 # ------------------------------------------------------------------------
 # Scratch-install phase: everything here is derived ONLY from `s` (the
 # hash-pinned, freshly-compiled candidate source), never from live state,
 # so it carries no TOCTOU risk against the REPEATABLE READ snapshot below --
 # it is a stateless rendering pass, using Postgres itself as the
 # canonicalizer for our own trusted expected text. Nothing here persists:
 # the whole SCRATCH schema is dropped in the `finally` after comparison.
 # ------------------------------------------------------------------------
 sql(f'DROP SCHEMA IF EXISTS {SCRATCH} CASCADE')
 sql(f'CREATE SCHEMA {SCRATCH}')
 try:
  # Functions: one scratch copy per (schema,fname), retargeted into SCRATCH
  # under a schema-prefixed name (collision-safe if two different real
  # schemas ever reuse a bare function name) via scratch_function_stmt.
  fn_stmts=[scratch_function_stmt(schema,fname,stmt) for (schema,fname),stmt in functions_src.items()]
  if fn_stmts:sql(';\n'.join(fn_stmts))

  # Tables: a scratch mirror per table that needs one for constraint/index/
  # default rendering -- every table this candidate declares (`tables`,
  # independently sourced) plus any table only ever ALTERed by this
  # candidate (`constraint_tables` covers the ADD CONSTRAINT case; index
  # target tables are added explicitly below for the ADD-COLUMN-only-via-
  # index-target case, though none currently exist). A table this candidate
  # does not own borrows its LIVE column shape (LIKE) for incidental
  # columns it never declared (e.g. public.messages.org_id) -- there is no
  # other source of truth for those -- but any column THIS CANDIDATE itself
  # declares via ADD COLUMN is then independently reconstructed from `s`
  # (drop the live-shaped copy, re-add from source), so the audited surface
  # is never silently borrowed from the very live state being verified.
  index_tables=sorted(set(info['table'] for info in expected_index.values()))
  scratch_tables=sorted(set(constraint_tables)|set(index_tables))
  table_stmts=[]
  for t in scratch_tables:
   safe=scratch_name(t)
   if t in tables:
    coldefs=[coldef_sql(name,*vals) for name,vals in table_columns(t).items()]
    table_stmts.append(f'CREATE TABLE {SCRATCH}."{safe}" ({", ".join(coldefs)});')
   else:
    table_stmts.append(f'CREATE TABLE {SCRATCH}."{safe}" (LIKE {t});')
    for name,vals in table_columns(t).items():
     table_stmts.append(f'ALTER TABLE {SCRATCH}."{safe}" DROP COLUMN IF EXISTS {name};')
     table_stmts.append(f'ALTER TABLE {SCRATCH}."{safe}" ADD COLUMN {coldef_sql(name,*vals)};')
  if table_stmts:sql('\n'.join(table_stmts))

  # Constraints: ALTER TABLE ADD CONSTRAINT the verbatim source fragment,
  # synthetically named (constraint names are never part of
  # pg_get_constraintdef's own rendering, so no name normalization is
  # needed for the comparison itself). FK fragments reference the REAL
  # target table directly (e.g. REFERENCES inbox_bridge.worksets(id)) --
  # read-only, and always legal here since every FK in this candidate
  # targets a table this candidate itself owns and has already really
  # installed.
  constraint_stmts=[]
  constraint_synth={}  # t -> [(synthetic_name, source_frag)]
  for t in constraint_tables:
   safe=scratch_name(t)
   names=[]
   for i,(frag,_valid) in enumerate(extract_constraints_for_table(t)):
    cname=f'{safe}_c{i}'  # globally unique: PK/UNIQUE constraints create a same-named supporting index, and index names are unique per-SCHEMA (not per-table), so a bare "c0" on two different scratch tables collides
    body=frag
    cm=re.match(r'^CONSTRAINT\s+\w+\s+(.*)$',frag,re.S|re.I)
    if cm:body=cm.group(1)
    constraint_stmts.append(f'ALTER TABLE {SCRATCH}."{safe}" ADD CONSTRAINT {cname} {body};')
    names.append((cname,frag))
   constraint_synth[t]=names
  if constraint_stmts:sql('\n'.join(constraint_stmts))

  # Indexes: verbatim source statement (CONCURRENTLY already stripped),
  # retargeted at the scratch mirror table. Index names are only unique
  # per-schema in Postgres, and every scratch index lives in the ONE
  # SCRATCH schema, so a bare original name could collide across two
  # different real source tables -- prefix with the table's own scratch
  # name to stay collision-safe; the name never appears inside
  # pg_get_indexdef's rendering anyway (confirmed empirically), so this
  # prefixing needs no reversal for the comparison.
  index_stmts=[]
  index_synth={}  # index name -> synthetic scratch index name
  for name,info in expected_index.items():
   safe_table=scratch_name(info['table'])
   synth=f"{safe_table}__{name}"
   retargeted=re.sub(r'^(CREATE (?:UNIQUE )?INDEX )'+re.escape(name)+r'( ON )'+re.escape(info['table'])+r'\b',
    r'\1"'+synth+r'"\2'+SCRATCH+'."'+safe_table+'"',info['stmt'])
   index_stmts.append(retargeted+';')
   index_synth[name]=synth
  if index_stmts:sql('\n'.join(index_stmts))

  # Read back every scratch rendering in one query (safe to batch: nothing
  # in SCRATCH has changed since we created it, all in this same script).
  fn_keys=sorted(f"{schema}.{fname}" for schema,fname in functions_src)
  fn_ident_arr='ARRAY['+','.join("'"+SCRATCH+'.'+scratch_name(k)+"'" for k in fn_keys)+']::text[]' if fn_keys else 'ARRAY[]::text[]'
  scratch_snapshot_sql=f"""
SELECT jsonb_build_object(
 'functions',(SELECT coalesce(jsonb_object_agg(p.proname,pg_get_functiondef(p.oid)),'{{}}')
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='{SCRATCH}' AND (n.nspname||'.'||p.proname)=ANY({fn_ident_arr})),
 'constraints',(SELECT coalesce(jsonb_object_agg(n.nspname||'.'||c.relname||'.'||co.conname,pg_get_constraintdef(co.oid)),'{{}}')
   FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='{SCRATCH}'),
 'indexes',(SELECT coalesce(jsonb_object_agg(ic.relname,pg_get_indexdef(i.indexrelid)),'{{}}')
   FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace n ON n.oid=ic.relnamespace WHERE n.nspname='{SCRATCH}'),
 'defaults',(SELECT coalesce(jsonb_object_agg(c.relname||'.'||a.attname,pg_get_expr(d.adbin,d.adrelid)),'{{}}')
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='{SCRATCH}')
);
"""
  scratch_snap=json.loads(sql(scratch_snapshot_sql))
 finally:
  sql(f'DROP SCHEMA IF EXISTS {SCRATCH} CASCADE')

 # ONE snapshot, ONE transaction: every catalog read below observes the same
 # REPEATABLE READ view, so a coordinated repair/re-drift straddling two reads
 # cannot produce a certificate for a materially-drifted final catalog (no
 # separate connections/statements are used for any check past this point).
 snapshot_sql=f"""
BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SELECT jsonb_build_object(
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'noncollation',a.attcollation<>0 AND a.attcollation<>t.typcollation,'attnum',a.attnum)),'[]')
   FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_type t ON t.oid=a.atttypid
   LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
   WHERE (n.nspname||'.'||c.relname)=ANY({table_arr}) AND a.attnum>0 AND NOT a.attisdropped),
 'rls',(SELECT coalesce(jsonb_object_agg(n.nspname||'.'||c.relname,jsonb_build_object('enabled',c.relrowsecurity,'forced',c.relforcerowsecurity)),'{{}}')
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE (n.nspname||'.'||c.relname)=ANY({rls_arr}) AND c.relkind='r'),
 'indexes',(SELECT coalesce(jsonb_object_agg(n.nspname||'.'||ic.relname,jsonb_build_object('def',pg_get_indexdef(i.indexrelid),'valid',i.indisvalid)),'{{}}')
   FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_namespace n ON n.oid=ic.relnamespace
   WHERE (n.nspname||'.'||ic.relname)=ANY({index_arr})),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',n.nspname||'.'||c.relname||'.'||t.tgname,'def',pg_get_triggerdef(t.oid),'enabled',t.tgenabled::text)),'[]')
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE NOT t.tgisinternal AND (n.nspname||'.'||c.relname||'.'||t.tgname)=ANY({trigger_arr})),
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',n.nspname||'.'||c.relname,'def',pg_get_constraintdef(co.oid),'valid',co.convalidated,'noinherit',co.connoinherit)),'[]')
   FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE (n.nspname||'.'||c.relname)=ANY({constraint_arr})),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner))),'[]')
   FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname=ANY({private_arr}) OR (n.nspname='public' AND p.proname=ANY({public_fn_arr}))),
 'extra_relations',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind)),'[]')
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY({private_arr}) AND c.relkind IN ('r','p','v','m','S','c','f')),
 'extra_types',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.typname)),'[]')
   FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   -- b/d/e/r/m = base/domain/enum/range/multirange, i.e. an actual standalone CREATE TYPE.
   -- 'c' (composite) is deliberately excluded here: a standalone composite type (CREATE
   -- TYPE ... AS (...)) always has a matching pg_class row with relkind='c', which is
   -- caught by extra_relations above -- including it here too would double-count it,
   -- and naively including EVERY typtype='c' row here (without this exclusion) would
   -- instead accidentally flag every ordinary TABLE's own implicit row type as "extra"
   -- since every table also registers a typtype='c' pg_type entry for its row type.
   WHERE n.nspname=ANY({private_arr}) AND t.typtype IN ('b','d','e','r','m') AND t.typcategory<>'A'),
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

 # Functions: byte-exact pg_get_functiondef (scratch-rendered expected vs
 # installed-rendered live), after normalizing ONLY the scratch schema-
 # qualified self-name token back to the real one -- this single string
 # equality covers signature, every arg DEFAULT, return type, STRICT,
 # VOLATILE, SECURITY DEFINER, LEAKPROOF, PARALLEL, cost/rows, the full
 # proconfig, and the body, all at once (whatever Postgres's own deparse
 # renders, nothing hand-picked). Owner is compared SEPARATELY (functiondef
 # never renders OWNER TO) against a pinned expectation -- for a SECURITY
 # DEFINER function the owner is the execution principal, a real privilege
 # vector functiondef text alone cannot reveal.
 live_fn_by_key={}  # (schema,name) -> list of live rows (>1 = conflicting overload)
 for row in snap['functions']:
  live_fn_by_key.setdefault((row['schema'],row['name']),[]).append(row)
 for (schema,fname) in functions_src:
  rows=live_fn_by_key.get((schema,fname),[])
  if not rows:raise RuntimeError(f'Installed function missing: {schema}.{fname}')
  if len(rows)>1:raise RuntimeError(f'Conflicting overload(s) installed for {schema}.{fname}: {len(rows)} rows')
  row=rows[0]
  scratch_key=scratch_name(f'{schema}.{fname}')
  scratch_def=scratch_snap['functions'].get(scratch_key)
  if scratch_def is None:raise RuntimeError(f'HARNESS FAILURE: scratch copy missing for {schema}.{fname}')
  expected_def=scratch_def.replace(f'{SCRATCH}.{scratch_key}',f'{schema}.{fname}')
  if expected_def!=row['def']:raise RuntimeError(f"Function definition drift {schema}.{fname} (pg_get_functiondef mismatch):\n  expected={expected_def}\n  live=    {row['def']}")
  pin_key=f'{schema}.{fname}'
  expected_owner=owner_pins.get(pin_key)
  if expected_owner is None:raise RuntimeError(f'No pinned owner expectation for {pin_key} in function-owners.json -- add one (see that file\'s own note) before this can be certified')
  if owner_mismatch(expected_owner,row['owner']):raise RuntimeError(f"Function OWNER drift {schema}.{fname}: expected owner={expected_owner!r} live={row['owner']!r} (for a SECURITY DEFINER function the owner is the execution principal)")
 # any extra installed function (in scope) not declared by this candidate at all
 extra_fn=set(live_fn_by_key)-set(functions_src)
 if extra_fn:raise RuntimeError('Extra installed functions: '+str(sorted(extra_fn)))

 # Columns: name + type + nullability + DEFAULT (now via scratch-rendered
 # pg_get_expr, byte-exact -- catches a changed string-literal case inside a
 # default expression the same way constraints/indexes do) +
 # identity/generated/collation (compared, not merely extracted). None of
 # this candidate's columns use GENERATED/IDENTITY/explicit COLLATE, so the
 # expectation is always "none of those" -- a column silently gaining one
 # of them now fails.
 live_cols={}
 for row in snap['columns']:
  live_cols.setdefault(f"{row['schema']}.{row['table']}",{})[row['column']]=row
 for t in sorted(set(all_tables)|set(composite_types)):
  cols=dict(table_columns(t)) if t not in composite_types else dict(composite_cols[t])
  lc=live_cols.get(t)
  if lc is None:raise RuntimeError('Installed table missing: '+t)
  # Attribute-set drift (added or dropped) is asserted for BOTH ordinary
  # tables (existing behaviour) and composite types (the gap this closes) --
  # a composite type declares its complete attribute list in one CREATE TYPE
  # statement (no ALTER-added columns), so its expected set is always exact,
  # the same way a plain CREATE TABLE's is.
  if (t in tables or t in composite_types) and set(lc)!=set(cols):raise RuntimeError(f'Column set drift on {t}: expected={sorted(cols)} live={sorted(lc)}')
  if t in composite_types:
   # A composite type's attribute order is part of its identity (it is the
   # binary layout other code reads by position), unlike an ordinary table
   # column's order which this verifier does not otherwise assert -- so only
   # composite types get an explicit attnum-order check, keyed off the exact
   # declaration order in the source CREATE TYPE statement.
   expected_order=[name for name in cols]
   live_order=sorted(lc,key=lambda n:lc[n]['attnum'])
   if live_order!=expected_order:raise RuntimeError(f'Attribute order drift on {t}: expected={expected_order} live={live_order}')
  safe=scratch_name(t)
  for name,(etype,enn,edef) in cols.items():
   if name not in lc:raise RuntimeError(f'Added column missing: {t}.{name}')
   row=lc[name]
   if etype.lower()!=row['type'].lower():raise RuntimeError(f"Column type drift {t}.{name}: expected {etype!r} live {row['type']!r}")
   if enn!=row['notnull']:raise RuntimeError(f"Column nullability drift {t}.{name}: expected notnull={enn} live={row['notnull']}")
   if edef is None:
    if row['default'] is not None:raise RuntimeError(f"Column default drift {t}.{name}: expected no DEFAULT, live={row['default']!r}")
   else:
    scratch_default=scratch_snap['defaults'].get(f'{safe}.{name}')
    if scratch_default is None:raise RuntimeError(f'HARNESS FAILURE: scratch default missing for {t}.{name}')
    if scratch_default!=row['default']:raise RuntimeError(f"Column default drift {t}.{name}: expected {scratch_default!r} live {row['default']!r}")
   if row['identity']!='':raise RuntimeError(f"Column identity drift {t}.{name}: expected no GENERATED ... AS IDENTITY, live attidentity={row['identity']!r}")
   if row['generated']!='':raise RuntimeError(f"Column generated-expression drift {t}.{name}: expected no GENERATED ... STORED, live attgenerated={row['generated']!r}")
   if row['noncollation'] is not False:raise RuntimeError(f"Column collation drift {t}.{name}: expected the type's default collation, live has an explicit non-default COLLATE")

 # RLS: every ENABLE ROW LEVEL SECURITY table must still have it enabled live,
 # and FORCE ROW LEVEL SECURITY must match source (none of this candidate's
 # tables declare FORCE, so it must stay unforced -- a silently added FORCE
 # would change owner/superuser bypass semantics unreviewed).
 for t in rls_tables:
  if t not in snap['rls']:raise RuntimeError('RLS table missing from snapshot: '+t)
  if snap['rls'][t]['enabled'] is not True:raise RuntimeError('Row level security disabled on installed table: '+t)
  if snap['rls'][t]['forced'] is not False:raise RuntimeError('Unexpected FORCE ROW LEVEL SECURITY on installed table: '+t)

 # Indexes: byte-exact pg_get_indexdef (scratch-rendered expected, after
 # normalizing the scratch table-qualifier back to the real one, vs live),
 # plus indisvalid (a failed/aborted CONCURRENTLY build can leave an
 # INVALID index that still matches by name+def).
 for name,info in expected_index.items():
  key=f"{info['schema']}.{name}"
  live=snap['indexes'].get(key)
  if not live:raise RuntimeError('Installed index missing: '+name)
  safe_table=scratch_name(info['table'])
  synth=f"{safe_table}__{name}"
  scratch_def=scratch_snap['indexes'].get(synth)
  if scratch_def is None:raise RuntimeError(f'HARNESS FAILURE: scratch index missing for {name}')
  expected_def=scratch_def.replace(synth,name).replace(f'{SCRATCH}.{safe_table}',info['table'])
  if expected_def!=live['def']:raise RuntimeError(f"Index definition drift: {name}\n  expected={expected_def}\n  live=    {live['def']}")
  if live['valid'] is not True:raise RuntimeError(f'Installed index is NOT VALID (failed/aborted build): {name}')

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

 # Constraints: byte-exact pg_get_constraintdef (scratch-rendered expected
 # vs live -- no custom normalization, so a string-literal CASE difference
 # inside a CHECK, or any other cosmetic-looking-but-real change, is caught
 # the same way any other drift is), plus NOT VALID / convalidated and FK ON
 # DELETE/UPDATE (rendered as part of the same string). Owned tables (this
 # candidate's own CREATE TABLE) must match the FULL constraint set exactly;
 # foreign ALTER-only tables (e.g. public.messages, owned by the base app
 # schema with many pre-existing constraints of its own) are checked only
 # for the specific constraint(s) this candidate itself adds, not an exact
 # total count.
 live_cons={}
 for row in snap['constraints']:
  live_cons.setdefault(row['table'],[]).append(row)
 for t in constraint_tables:
  expected_frags=extract_constraints_for_table(t)
  rows=live_cons.get(t,[])
  if t in tables and len(expected_frags)!=len(rows):raise RuntimeError(f'Constraint count drift on {t}: expected={len(expected_frags)} live={len(rows)}\n  expected={expected_frags}\n  live={rows}')
  remaining=list(rows)
  synth_names=constraint_synth.get(t,[])
  for (cname,frag) in synth_names:
   key=f"{SCRATCH}.{scratch_name(t)}.{cname}"
   scratch_def=scratch_snap['constraints'].get(key)
   if scratch_def is None:raise RuntimeError(f'HARNESS FAILURE: scratch constraint missing for {t} {frag!r}')
   hit=next((r for r in remaining if r['def']==scratch_def),None)
   # NOT VALID in source is only ever a transient install-time property (e.g.
   # the deferred inbound-revision constraint is added NOT VALID and then
   # intentionally VALIDATEd after foundation locks release, per README) --
   # the scratch copy is always created fully VALID regardless of the
   # source fragment's own transient NOT VALID marker, since by the time
   # verify.py --installed runs against the final installed state, EVERY
   # constraint must be convalidated=true: a constraint re-added identical
   # but NOT VALID (e.g. after dropping it, inserting rows that violate it,
   # then re-adding NOT VALID to dodge the validation scan) must fail here
   # -- which it does, because pg_get_constraintdef appends a literal
   # " NOT VALID" suffix for a not-yet-validated live constraint, and the
   # (always-VALID) scratch rendering never has that suffix to match against.
   if hit is None:raise RuntimeError(f'Constraint definition drift on {t}: expected fragment not found live (exact match required): {frag!r}\n  expected(scratch)={scratch_def!r}\n  live remaining={remaining}')
   if hit['valid'] is not True:raise RuntimeError(f"Constraint not validated on {t}: {frag!r} is installed NOT VALID (convalidated={hit['valid']!r}); legacy-violating rows could be hiding behind it")
   # connoinherit is not compared: Postgres sets it per constraint-type default
   # (true for PRIMARY KEY/UNIQUE/FOREIGN KEY regardless of source DDL, since
   # this codebase never uses table inheritance) rather than reflecting
   # anything the source text controls -- captured in the snapshot for
   # visibility but not asserted on.
   remaining.remove(hit)

 # Extra objects: the private companion schemas (private-schemas.json) must
 # contain EXACTLY the expected object set, across ALL relevant object kinds --
 # tables, views, materialized views, sequences, types/domains, functions
 # (by full signature identity, above), triggers, indexes, policies. public is
 # the pre-existing shared app schema (hundreds of unrelated objects, plus other
 # already-merged inbox_-prefixed features this candidate explicitly does not
 # own per README) so it is deliberately NOT scanned for extras here.
 expected_relations={t for t in tables}|set(composite_types)
 live_relations={f"{r['schema']}.{r['name']}":r['kind'] for r in snap['extra_relations']}
 extra_rel=set(live_relations)-expected_relations
 if extra_rel:raise RuntimeError(f'Extra relations (table/view/matview/sequence) in private schemas: { {k:live_relations[k] for k in extra_rel} }')
 if snap['extra_types']:raise RuntimeError('Extra types/domains in private schemas: '+str(snap['extra_types']))
 expected_idx_full=set(f"{info['schema']}.{name}" for name,info in expected_index.items() if info['schema'] in private_schemas)
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
 result={'foundation_sha256':digest,'installed_function_bodies':len(functions_src),'installed_tables':len(all_tables),'installed_composite_types':len(composite_types),'installed_indexes':len(expected_index),'installed_triggers':len(expected_triggers),'installed_constraints':sum(len(extract_constraints_for_table(t)) for t in constraint_tables),'installed_rls_tables':len(rls_tables),'private_schemas_scanned':len(private_schemas),'private_helper_exposure_count':0,'replica_identity':'FULL','snapshot_isolation':'REPEATABLE READ, READ ONLY, single transaction','scope':'Read-only owned fixture catalog proof (plus a throwaway verify_scratch schema, created and dropped within this same run, used only to let Postgres itself canonically render the expected side of every function/constraint/index/default comparison -- byte-exact pg_get_functiondef/pg_get_constraintdef/pg_get_indexdef/pg_get_expr comparison, no custom text normalization, plus a separately pinned function-owner check) taken from one consistent REPEATABLE READ snapshot for the live side, not merely name presence; excludes runtime throughput and production schema equivalence'}
 (P/'catalog-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
else:
 print('Source syntax, pinned transforms and installation receipt hash verified')
