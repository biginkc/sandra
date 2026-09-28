#!/usr/bin/env python3
"""Verify compiler determinism and, with --installed, the exact guarded installed schema."""
import argparse,ast,atexit,hashlib,json,os,re,shutil,subprocess,sys,tempfile
from pathlib import Path
P=Path(__file__).resolve().parent
ap=argparse.ArgumentParser();ap.add_argument('--installed',action='store_true');ap.add_argument('--selftest',action='store_true');ap.add_argument('--source-only',action='store_true');ap.add_argument('--target',choices=('release-db','http'),default=os.environ.get('INBOX_RELEASE_TARGET_PROFILE','release-db'));a=ap.parse_args()
os.environ['INBOX_RELEASE_TARGET_PROFILE']=a.target
manifest=P/'source-manifest.json'
if manifest.exists():
 for name,digest in json.loads(manifest.read_text()).items():
  if hashlib.sha256((P/name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Bundle source manifest drift: '+name)
for f in P.glob('*.py'):ast.parse(f.read_text(),filename=str(f))
# Profile-specific compilation rewrites generated/ (for example, the HTTP
# fixture replaces release-database guards).  Keep that scratch output out of
# the checked-in bundle even when a later compiler or installed check fails.
# The restore runs for normal exits and exceptions; a hard process kill cannot
# run Python cleanup and therefore remains an operationally distinct failure.
_generated_dir=P/'generated'
_generated_backup_root=Path(tempfile.mkdtemp(prefix='inbox-verify-generated-'))
_generated_backup=_generated_backup_root/'generated'
_generated_existed=_generated_dir.exists()
if _generated_existed:
 shutil.copytree(_generated_dir,_generated_backup)
def _restore_generated() -> None:
 shutil.rmtree(_generated_dir,ignore_errors=True)
 if _generated_existed:
  shutil.copytree(_generated_backup,_generated_dir)
 shutil.rmtree(_generated_backup_root,ignore_errors=True)
atexit.register(_restore_generated)
# Wipe generated/ before regenerating: build.py and read-companion.py always fully
# rewrite every file they own from hash-verified pinned source, so a clean wipe means
# nothing here can ever read a stale or injected file left over from a prior run (an
# injected extra generated/index-08.sql, a stale generated/install-candidate.sql
# nobody regenerated, etc.) -- everything "expected" below is derived exclusively
# from what THIS run's compilers, running against the manifest-pinned source we just
# hash-checked above, just wrote.
shutil.rmtree(P/'generated',ignore_errors=True)
subprocess.run([sys.executable,str(P/'build.py')],check=True)
subprocess.run([sys.executable,str(P/'read-companion.py'),'--target',a.target],check=True)
foundation=P/'generated/install-candidate.sql';cand=foundation.read_text();digest=hashlib.sha256(foundation.read_bytes()).hexdigest()
companion_path=P/'generated/read-companion.sql'
companion=companion_path.read_text() if companion_path.exists() else ''

def installer_owner_contract():
 # Ownership is an installer contract, not a value that a previous catalog
 # snapshot is allowed to redefine. build.py rejects every role other than the
 # migration role and creates each candidate schema with AUTHORIZATION.
 build_contract=(P/'build.py').read_text()
 migration_roles=sorted(set(re.findall(r"current_user<>?'([^']+)'",build_contract)))
 authorized_roles=sorted(set(re.findall(r'CREATE SCHEMA \w+ AUTHORIZATION (\w+)',build_contract)))
 if migration_roles!=['postgres'] or authorized_roles!=['postgres']:
  raise RuntimeError('Installer owner contract drift: build.py must require and authorize postgres')
 return 'postgres'

INSTALLER_OWNER=installer_owner_contract()
column_acl_contract=json.loads((P/'column-acl.json').read_text()) if (P/'column-acl.json').exists() else {}
if column_acl_contract.get('contract')!='no-column-specific-grants':
 raise RuntimeError('column-acl.json must declare the reviewed no-column-specific-grants contract')
if any(value!=INSTALLER_OWNER for value in json.loads((P/'function-owners.json').read_text()).values()):
 raise RuntimeError('function-owners.json contains a value outside the installer owner contract')
if any(value!=INSTALLER_OWNER for value in json.loads((P/'relation-owners.json').read_text()).values()):
 raise RuntimeError('relation-owners.json contains a value outside the installer owner contract')
if re.search(r'\bGRANT\s+[A-Z ,]+\([^)]*\)\s+ON\s+',cand+'\n'+companion,re.I):
 raise RuntimeError('Source candidate contains column-specific GRANT syntax but column-acl.json declares no-column-specific-grants')

def receipt_contract(candidate_sha):
 # The DB-less gate must reject a source bundle whose installed receipt or
 # catalog-pin provenance is absent, stale, or malformed.  The catalog hash is
 # produced from the complete guarded read by generate-catalog-pins.py; this
 # gate validates its binding to the exact candidate and generator, while the
 # installed verifier remains responsible for the live catalog comparison.
 install_path=P/'install-evidence.json'
 provenance_path=P/'catalog-pin-provenance.json'
 if not install_path.exists():
  raise RuntimeError('Missing install-evidence.json; source-only cannot certify an unrecorded installation')
 if not provenance_path.exists():
  raise RuntimeError('Missing catalog-pin-provenance.json; source-only cannot certify unproven catalog pins')
 try:
  install=json.loads(install_path.read_text())
  provenance=json.loads(provenance_path.read_text())
 except (OSError,json.JSONDecodeError) as e:
  raise RuntimeError(f'Unreadable installer receipt/provenance: {e}') from e
 if install.get('installed') is not True or install.get('serving_enabled') is not False:
  raise RuntimeError('install-evidence.json must record installed=true and serving_enabled=false')
 if install.get('source_sha256')!=candidate_sha:
  raise RuntimeError('install-evidence.json source_sha256 does not match generated candidate')
 if provenance.get('generator')!='generate-catalog-pins.py':
  raise RuntimeError('catalog-pin-provenance.json generator identity drift')
 generator_sha=hashlib.sha256((P/'generate-catalog-pins.py').read_bytes()).hexdigest()
 if provenance.get('generator_sha256')!=generator_sha:
  raise RuntimeError('catalog-pin-provenance.json generator_sha256 does not match this source')
 if provenance.get('installer_owner')!=INSTALLER_OWNER:
  raise RuntimeError('catalog-pin-provenance.json installer owner drift')
 if provenance.get('candidate_sha256')!=candidate_sha:
  raise RuntimeError('catalog-pin-provenance.json candidate_sha256 does not match generated candidate')
 for key in ('catalog_snapshot_sha256','pin_output_sha256'):
  value=provenance.get(key)
  if not isinstance(value,str) or re.fullmatch(r'[0-9a-f]{64}',value) is None:
   raise RuntimeError(f'catalog-pin-provenance.json {key} must be a SHA-256 digest')
 try:
  pin_outputs={
   'function_owners':json.loads((P/'function-owners.json').read_text()),
   'function_grants':json.loads((P/'function-grants.json').read_text()),
   'relation_owners':json.loads((P/'relation-owners.json').read_text()),
   'relation_acls':json.loads((P/'relation-acl.json').read_text()),
   'column_acls':column_acl_contract.get('columns',{}),
  }
 except (OSError,json.JSONDecodeError,AttributeError) as e:
  raise RuntimeError(f'Unreadable catalog pin file: {e}') from e
 pin_output_sha=hashlib.sha256(json.dumps(pin_outputs,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 if provenance.get('pin_output_sha256')!=pin_output_sha:
  raise RuntimeError('catalog-pin-provenance.json pin_output_sha256 does not match canonical pin files')
 return install

receipt=receipt_contract(digest)
if a.source_only:
 print('Source-manifest hashes, compiler outputs, installation receipt, and catalog-pin provenance contract match (no DB).')
 sys.exit(0)
# The companion (read/history) namespace and the main candidate share the same
# installed catalog (inbox_* schemas, pinned canonical helpers). All structural
# checks below are derived from BOTH sources combined, so drift in the companion
# alone is caught the same way as in the foundation.
s=cand+'\n'+companion
drifted=receipt['source_sha256']!=digest
if drifted:
 correction=P/'hardening-evidence.json'
 if not correction.exists() or json.loads(correction.read_text())['foundation_sha256']!=digest:
  raise RuntimeError('Generated foundation differs from recorded installation and verified forward correction; never relabel old evidence')
 # Preserve the candidate's forward-correction admission guard: a changed
 # foundation may only be certified by --installed against the live catalog.
 # --selftest exercises shared comparison helpers but is never a substitute
 # for installed-catalog proof.
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
# separately against a pinned expectation, function-owners.json), GRANTS
# (pg_get_functiondef never renders them either -- pinned separately in
# function-grants.json, same reasoning), and TRIGGER enforcement (ENABLED
# state, including internal FK-enforcement triggers pg_get_triggerdef never
# lists at all -- see the constraint loop's triggers_ok check below).
#
# CONTRACT NOTE on "no false positives" above (Astra round 5, gap #5 --
# not a bug, a scope clarification): that guarantee is about Postgres's own
# COSMETIC RE-FORMATTING of an attribute/constraint/index/trigger
# declaration -- e.g. `(a+99)/100` vs the extra parens Postgres adds back
# when it re-prints that same expression. It does NOT extend to a
# function's BODY. A function body is compared byte-exact to source,
# comments included, on purpose: this is an INSTALL verifier -- the
# installer installs the exact source text, so "the installed body no
# longer matches what would be installed from current source" (even a
# comment-only edit) IS real drift for this file's job, and must keep
# failing. Do not add body normalization/comment-stripping to "reduce
# false positives" here -- that would hide genuine, in-scope drift.
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
for m in re.finditer(r'ALTER TABLE ([\w.]+)\s+ADD COLUMN (?:IF NOT EXISTS )?(.+?);',s,re.S):
 for coldef in split_top_level(m.group(2)):
  coldef=re.sub(r'^\s*ADD COLUMN (?:IF NOT EXISTS )?', '', coldef, flags=re.I)
  if coldef.strip(): added_cols.setdefault(m.group(1),[]).append(coldef.strip())
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
def trigger_identity(stmt):
 # ONLY for extracting the (table,name) identity of a trigger statement --
 # used to key expected_triggers below. Round-5 (Astra NO/5, gap #2) no
 # longer uses this to compare trigger DEFINITIONS: the old field-by-field
 # comparison lowercased and whitespace-stripped the trigger's own args
 # (e.g. a capture arg 'property' -> 'PROPERTY' compared equal), the same
 # class of gap as the arithmetic-regrouping/string-literal-case bugs fixed
 # in earlier rounds. Trigger definitions are now compared byte-exact via
 # scratch-installed pg_get_triggerdef() instead (see scratch_trigger_stmt
 # below) -- this function is now identity-only and asserts nothing about
 # args/events/timing.
 flat=re.sub(r'\s+',' ',stmt).strip().rstrip(';')
 m=TRIGGER_RE.search(flat)
 if not m:raise RuntimeError('Could not parse trigger statement: '+flat)
 name,_timing,_events_raw,table,_roworstmt,_fn,_args=m.groups()
 return table.lower(),name
expected_triggers={}  # (table,name) -> verbatim source CREATE TRIGGER statement
for stmt in trigger_stmts:
 table,name=trigger_identity(stmt)
 expected_triggers[(table,name)]=stmt

def scratch_trigger_stmt(table,name,stmt):
 # Retarget a verbatim CREATE TRIGGER statement at the table's scratch
 # mirror, synthetically renamed (trigger names are unique per-TABLE in
 # Postgres, not globally, and every scratch trigger lives in the one
 # SCRATCH schema across many different mirrored tables, so a bare
 # original name could collide the same way index names could -- see
 # scratch index naming above). The EXECUTE FUNCTION reference is left
 # untouched: it must point at the REAL installed function (read-only
 # reference, never executed at CREATE TRIGGER time) so the rendered
 # trigger definition matches what the live trigger -- which also points
 # at the real function -- renders.
 flat=re.sub(r'\s+',' ',stmt).strip().rstrip(';')
 safe_table=scratch_name(table)
 synth=f'{safe_table}__{name}'
 new,n1=re.subn(r'^CREATE TRIGGER '+re.escape(name)+r'\b','CREATE TRIGGER '+synth,flat,count=1)
 if n1!=1:raise RuntimeError('Could not retarget scratch trigger name for '+name)
 new,n2=re.subn(r'\bON\s+'+re.escape(table)+r'\b','ON '+SCRATCH+'."'+safe_table+'"',new,count=1)
 if n2!=1:raise RuntimeError('Could not retarget scratch trigger table for '+name+' on '+table)
 return new+';',synth

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
 for m in re.finditer(r'ALTER TABLE\s+'+re.escape(t)+r'\s+ADD CONSTRAINT\s+\w+\s+([^;]+);',s,re.S):
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

def pinned_owner(pins,pin_key,filename):
 expected=pins.get(pin_key)
 if expected is None:raise RuntimeError(f'No pinned owner expectation for {pin_key} in {filename} -- add one before this can be certified')
 if expected!=INSTALLER_OWNER:raise RuntimeError(f'Owner pin contract drift for {pin_key}: {filename} says {expected!r}, but build.py authorizes only {INSTALLER_OWNER!r}')
 return INSTALLER_OWNER
# Astra round 5, gap #1: verify.py's privilege_exposure check only scanned
# the PRIVATE inbox_* schemas -- public-facing RPC wrapper functions
# (public.inbox_*) were never checked at all, so `GRANT EXECUTE ON
# public.inbox_counts_v2(...) TO anon` left verify.py green. There is no
# source-derivable "expected grant set" the way there is for a column type
# or a constraint expression (GRANT/REVOKE statements are scattered across
# the bundle and their net effect after every later REVOKE ALL ON ALL
# FUNCTIONS IN SCHEMA sweep is not something safe to hand-simulate here --
# get that sequencing subtly wrong and this file itself becomes the source
# of a false certificate), so -- same philosophy as function-owners.json --
# the expected direct EXECUTE ACL facts for every non-owner grantee, including
# PUBLIC/anon/authenticated/service_role and worker roles, including the
# grantable bit, are PINNED from the reviewed SQL grant policy and hash-pinned
# in source-manifest.json like every other pinned fact in this bundle. The pin
# deliberately excludes only the owner ACL, which is checked separately by
# function-owners.json; inherited role membership cannot hide a direct grant.
grant_pins=json.loads((P/'function-grants.json').read_text()) if (P/'function-grants.json').exists() else {}
# Astra round 6, gaps #1-#2: verify.py hardened FUNCTIONS thoroughly
# (byte-exact def, pinned owner, pinned grants) but only partially covered
# TABLES/SCHEMAS/TYPES -- ownership and full ACL (including WITH GRANT
# OPTION, which turns up as a "*" suffix on a privilege letter inside the
# raw aclitem text, e.g. "bob=r*w/postgres") were never compared for
# relations at all, so `ALTER TABLE public.inbox_inbound_heads OWNER TO
# authenticated` passed silently -- and a TABLE's OWNER bypasses RLS
# entirely (RLS only restricts non-owners unless FORCE ROW LEVEL SECURITY
# is also set), a sharper privilege escalation than a function-owner
# change. Same pinning philosophy as function-owners.json/
# function-grants.json (there is no safe way to derive "the expected ACL"
# from source text alone -- REVOKE/GRANT ordering effects are exactly what
# rounds 4-5 moved away from hand-simulating), extended to every table
# this candidate declares (`tables`), every private schema it creates, and
# every composite type it declares.
relation_owner_pins=json.loads((P/'relation-owners.json').read_text()) if (P/'relation-owners.json').exists() else {}
relation_acl_pins=json.loads((P/'relation-acl.json').read_text()) if (P/'relation-acl.json').exists() else {}

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

def assert_deparse_match(kind,identity,expected,live):
 # The ONE equality check every canonical-deparse comparison funnels
 # through -- functions, indexes and triggers all call this SAME function
 # for their expected-vs-live comparison, and --selftest calls it directly
 # too (Astra round 5, gap #4: the prior selftest hand-wrote its own
 # separate `if installed_a!=ok_a:` comparisons rather than calling the
 # code --installed actually runs, so disabling/weakening the real
 # comparison in --installed left selftest green). Weakening or deleting
 # the comparison here breaks every category AND --selftest together, not
 # just whichever call site someone happened to edit.
 if expected!=live:raise RuntimeError(f'{kind} definition drift {identity}:\n  expected={expected}\n  live=    {live}')

def find_constraint_match(remaining,scratch_def):
 # The ONE search --installed's constraint loop and --selftest both use to
 # find a live constraint whose pg_get_constraintdef matches a scratch-
 # rendered expected string (constraints are order-independent within a
 # table, so this is a search, not a direct pairwise compare like
 # assert_deparse_match) -- same load-bearing rationale as above.
 return next((r for r in remaining if r['def']==scratch_def),None)

def acl_mismatch(expected,live):
 # The ONE comparison --installed's function/table/schema/type ACL checks AND
 # --selftest all call.  Relation ACLs are raw aclitem text (for example
 # "bob=r*w/postgres"); function ACLs are normalized aclexplode records
 # containing grantee, privilege_type and is_grantable.  Sorting by repr keeps
 # both representations order-independent while preserving WITH GRANT OPTION
 # (the '*' suffix in aclitem text, or is_grantable=true in function records).
 return sorted(expected,key=repr)!=sorted(live,key=repr)

def relation_set_mismatch(expected,live):
 # The ONE comparison --installed's rewrite-rule/RLS-policy/trigger EXACT
 # SET checks AND --selftest both call (round 6, gaps #3-#5) -- each of
 # those is "the live set of names/defs must equal the expected set,
 # order-independent," so one shared order-independent equality serves all
 # three, the same way assert_deparse_match serves every byte-exact pair.
 # Sorted by repr rather than natural ordering: policy entries are dicts
 # (roles/cmd/using/withcheck), which Python cannot sort directly, while
 # rule/trigger entries are plain name strings -- repr-keyed sorting
 # handles either shape identically without a separate code path per kind.
 return sorted(expected,key=repr)!=sorted(live,key=repr)

if a.selftest:
 # DB-backed regression guard for the SHARED production comparator.
 # Round-4 selftest tested hand-written duplicate comparison snippets (a
 # separate bool_ast call, a separately written proconfig-list equality)
 # that stayed green even if the REAL --installed comparator was gutted or
 # narrowed -- not load-bearing. Astra round 5 (gap #4) demonstrated this
 # concretely: making scratch_function_stmt() raise, and separately
 # disabling --installed's function-definition comparison, both left that
 # selftest green, because it never called either one -- it built its own
 # separate inline CREATE FUNCTION text and its own separate `!=` checks.
 # This version calls the ACTUAL functions --installed uses --
 # scratch_function_stmt, scratch_trigger_stmt, assert_deparse_match,
 # find_constraint_match, owner_mismatch -- imported/defined nowhere else,
 # so breaking any of them the way Astra did breaks this too (verified
 # below each assertion's comment, and proven by deliberately reverting
 # each one during this round's testing).
 if a.target=='http':
  from http_fixture_db import guard,sql
 else:
  from fixture_db import guard,sql
 guard()
 def must_pass(label,fn):
  try:fn()
  except RuntimeError as e:print(f'SELFTEST FAIL: {label} should NOT have raised (false positive)\n  {e}',file=sys.stderr);sys.exit(1)
 def must_raise(label,fn):
  try:fn()
  except RuntimeError:return
  print(f'SELFTEST FAIL: {label} should have raised (missed drift) but did not',file=sys.stderr);sys.exit(1)
 sql(f'DROP SCHEMA IF EXISTS {SCRATCH} CASCADE')
 sql(f'CREATE SCHEMA {SCRATCH}')
 try:
  # Function: build the "expected" side via the REAL scratch_function_stmt
  # (not hand-written scratch DDL), and drive the pass/fail assertion
  # through the REAL assert_deparse_match. multi-SET proconfig
  # (search_path + session_replication_role, the round-3 attack) and arg
  # DEFAULT/RETURN TYPE (round-4) are exercised in one function so a
  # single scratch_function_stmt() call proves all three via the one
  # functiondef string.
  src_ok=f"CREATE FUNCTION {SCRATCH+'_src'}.fn_a(x integer DEFAULT 1) RETURNS integer LANGUAGE sql SET search_path='' SET session_replication_role=replica AS $$ SELECT x $$;"
  sql(f'CREATE SCHEMA IF NOT EXISTS {SCRATCH}_src')
  sql(src_ok,role='supabase_admin')  # the "installed" copy, created directly under its real name
  scratch_stmt=scratch_function_stmt(f'{SCRATCH}_src','fn_a',src_ok)
  synth=scratch_name(f'{SCRATCH}_src.fn_a')
  sql(scratch_stmt,role='supabase_admin')
  live_def=sql(f"SELECT pg_get_functiondef('{SCRATCH}_src.fn_a(integer)'::regprocedure)")
  scratch_def=sql(f"SELECT pg_get_functiondef('{SCRATCH}.{synth}(integer)'::regprocedure)")
  expected_def=scratch_def.replace(f'{SCRATCH}.{synth}',f'{SCRATCH}_src.fn_a')
  must_pass('a correctly-declared function (multi-SET proconfig + arg DEFAULT) vs its own installed copy',
   lambda:assert_deparse_match('Function','fn_a',expected_def,live_def))
  # Now the SAME expected (scratch_function_stmt output) against installed
  # copies that each drift by exactly one attribute -- proves
  # scratch_function_stmt + assert_deparse_match together, not a
  # hand-rolled duplicate, catch each class.
  sql(f'DROP FUNCTION {SCRATCH}_src.fn_a(integer)')
  sql(f"CREATE FUNCTION {SCRATCH}_src.fn_a(x integer DEFAULT 1) RETURNS integer LANGUAGE sql SET search_path='' AS $$ SELECT x $$",role='supabase_admin')  # missing session_replication_role
  live_bad_config=sql(f"SELECT pg_get_functiondef('{SCRATCH}_src.fn_a(integer)'::regprocedure)")
  must_raise('a live function missing session_replication_role=replica vs the multi-SET expected',
   lambda:assert_deparse_match('Function','fn_a',expected_def,live_bad_config))
  sql(f'DROP FUNCTION {SCRATCH}_src.fn_a(integer)')
  sql(src_ok,role='supabase_admin')
  sql(f'ALTER FUNCTION {SCRATCH}_src.fn_a(integer) SET search_path=public',role='supabase_admin')
  sql(f'ALTER FUNCTION {SCRATCH}_src.fn_a(integer) SET session_replication_role=replica',role='supabase_admin')
  live_default_drift=sql(f"SELECT pg_get_functiondef('{SCRATCH}_src.fn_a(integer)'::regprocedure)")
  # (search_path changed too, incidentally -- still proves a real drift is caught)
  must_raise('a live function with a changed proconfig value vs the expected',
   lambda:assert_deparse_match('Function','fn_a',expected_def,live_default_drift))

  # Owner: pg_get_functiondef never renders OWNER TO, so --installed
  # compares it SEPARATELY via owner_mismatch(). Prove that comparison
  # actually distinguishes two different real owners -- not just that a
  # function owns itself.
  sql(f'CREATE FUNCTION {SCRATCH}.owner_a() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
  sql(f'CREATE FUNCTION {SCRATCH}.owner_b() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$')
  sql(f'ALTER FUNCTION {SCRATCH}.owner_b() OWNER TO supabase_admin',role='supabase_admin')
  owner_a=sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='{SCRATCH}.owner_a()'::regprocedure")
  owner_b=sql(f"SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid='{SCRATCH}.owner_b()'::regprocedure")
  if owner_a!=INSTALLER_OWNER:
   print(f'SELFTEST FAIL: expected the installer role ({INSTALLER_OWNER}) to own its own freshly-created function, got {owner_a!r}',file=sys.stderr);sys.exit(1)
  if owner_b!='supabase_admin':
   print(f'SELFTEST FAIL: expected ALTER FUNCTION ... OWNER TO supabase_admin to take effect, got {owner_b!r}',file=sys.stderr);sys.exit(1)
  if not owner_mismatch(owner_a,owner_b):
   print(f'SELFTEST FAIL: owner_mismatch({INSTALLER_OWNER}, supabase_admin) returned False -- the SAME function --installed calls for the owner check is back to a no-op',file=sys.stderr);sys.exit(1)
  if owner_mismatch(owner_a,owner_a):
   print(f'SELFTEST FAIL: owner_mismatch({INSTALLER_OWNER}, {INSTALLER_OWNER}) returned True -- false positive on a matching owner',file=sys.stderr);sys.exit(1)

  # CHECK constraint: string-literal case (Astra demonstrated bool_ast
  # lowercased every leaf, so 'DONE' vs 'done' compared equal) AND the
  # search itself, via the REAL find_constraint_match -- a live row list
  # containing the drifted def must NOT be found by the correct expected
  # scratch_def.
  sql(f'CREATE TABLE {SCRATCH}.lit_a (stream text)')
  sql(f"ALTER TABLE {SCRATCH}.lit_a ADD CONSTRAINT c_ok CHECK (stream <> 'done')")
  sql(f"ALTER TABLE {SCRATCH}.lit_a ADD CONSTRAINT c_bad CHECK (stream <> 'DONE')")
  rows=[{'def':d} for d in json.loads(sql(f"SELECT coalesce(jsonb_agg(pg_get_constraintdef(oid)),'[]') FROM pg_constraint WHERE conrelid='{SCRATCH}.lit_a'::regclass"))]
  expected_check=sql(f"SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='{SCRATCH}.lit_a'::regclass AND conname='c_ok'")
  if find_constraint_match(rows,expected_check) is None:
   print('SELFTEST FAIL: find_constraint_match did not find the matching (identical) constraint definition -- false negative',file=sys.stderr);sys.exit(1)
  drifted_check=expected_check.replace("'done'","'DONE'")
  if drifted_check==expected_check:raise RuntimeError('HARNESS FAILURE: literal-case substitution produced no change')
  other_rows=[r for r in rows if r['def']!=expected_check]  # simulate "the correct one got dropped/replaced"
  if find_constraint_match(other_rows,expected_check) is not None:
   print("SELFTEST FAIL: find_constraint_match matched CHECK (stream <> 'DONE') against an expected CHECK (stream <> 'done') -- string-literal-case gap is back",file=sys.stderr);sys.exit(1)

  # Index predicate: same case-sensitivity, via assert_deparse_match.
  sql(f'CREATE TABLE {SCRATCH}.lit_idx_a (stream text)')
  sql(f'CREATE TABLE {SCRATCH}.lit_idx_b (stream text)')
  sql(f"CREATE INDEX lit_idx_a_i ON {SCRATCH}.lit_idx_a (stream) WHERE stream <> 'DONE'")
  sql(f"CREATE INDEX lit_idx_b_i ON {SCRATCH}.lit_idx_b (stream) WHERE stream <> 'done'")
  idx_a=sql(f"SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid='{SCRATCH}.lit_idx_a_i'::regclass").replace('lit_idx_a','lit_idx_x')
  idx_b=sql(f"SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid='{SCRATCH}.lit_idx_b_i'::regclass").replace('lit_idx_b','lit_idx_x')
  must_raise("an index predicate on 'DONE' vs the expected on 'done'",lambda:assert_deparse_match('Index','lit_idx_x_i',idx_b,idx_a))
  must_pass('an index predicate compared against its own identical text',lambda:assert_deparse_match('Index','lit_idx_x_i',idx_a,idx_a))

  # Trigger: round-5 gap #2 -- the old field-by-field comparison
  # lowercased+whitespace-stripped trigger args, so 'property'->'PROPERTY'
  # compared equal. Prove scratch_trigger_stmt + assert_deparse_match catch
  # an arg-case change, via the REAL retargeting function.
  sql(f'CREATE SCHEMA IF NOT EXISTS {SCRATCH}_src')
  sql(f'CREATE TABLE {SCRATCH}_src.trig_tbl (property text)')
  sql(f'CREATE FUNCTION {SCRATCH}_src.trig_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$')
  trig_table=f'{SCRATCH}_src.trig_tbl'
  trig_src_ok=f"CREATE TRIGGER t AFTER INSERT ON {trig_table} FOR EACH ROW EXECUTE FUNCTION {SCRATCH}_src.trig_fn('property')"
  sql(trig_src_ok)
  live_trig_def=sql(f"SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='t' AND tgrelid='{trig_table}'::regclass")
  sql(f'CREATE TABLE {SCRATCH}."{scratch_name(trig_table)}" (LIKE {trig_table})')
  scratch_trig_stmt,trig_synth=scratch_trigger_stmt(trig_table,'t',trig_src_ok)
  sql(scratch_trig_stmt)
  scratch_trig_def=sql(f"SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='{trig_synth}'")
  expected_trig_def=scratch_trig_def.replace(trig_synth,'t').replace(f'{SCRATCH}.{scratch_name(trig_table)}',trig_table)
  must_pass('a correctly-declared trigger vs its own installed copy',
   lambda:assert_deparse_match('Trigger','trig_tbl.t',expected_trig_def,live_trig_def))
  sql(f'DROP TRIGGER t ON {trig_table}')
  sql(trig_src_ok.replace("'property'","'PROPERTY'"))
  live_trig_drift=sql(f"SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='t' AND tgrelid='{trig_table}'::regclass")
  must_raise("a trigger arg 'PROPERTY' vs the expected 'property'",
   lambda:assert_deparse_match('Trigger','trig_tbl.t',expected_trig_def,live_trig_drift))

  # Relation-level comparators (Astra round 6, gaps #1/#3-#5): the SAME
  # acl_mismatch/relation_set_mismatch functions --installed calls for
  # table/schema/type ACL and for rewrite-rule/policy/trigger exact-set
  # checks.
  if acl_mismatch(['postgres=arwdDxt/postgres'],['postgres=arwdDxt/postgres']):
   print('SELFTEST FAIL: acl_mismatch on two identical ACL arrays returned True (false positive)',file=sys.stderr);sys.exit(1)
  if not acl_mismatch(['postgres=arwdDxt/postgres'],['postgres=arwdDxt/postgres','anon=r/postgres']):
   print('SELFTEST FAIL: acl_mismatch did not detect an ADDED grant -- the ACL gap is back',file=sys.stderr);sys.exit(1)
  if not acl_mismatch(['bob=r/postgres'],['bob=r*/postgres']):
   print("SELFTEST FAIL: acl_mismatch did not detect a relation WITH GRANT OPTION change ('*' suffix) -- the grant-option gap is back",file=sys.stderr);sys.exit(1)
  function_acl=[{'grantee':'authenticated','privilege_type':'EXECUTE','grantable':False}]
  function_acl_grantable=[{'grantee':'authenticated','privilege_type':'EXECUTE','grantable':True}]
  if not acl_mismatch(function_acl,function_acl_grantable):
   print('SELFTEST FAIL: acl_mismatch did not detect a function EXECUTE WITH GRANT OPTION change -- the function grant-option gap is back',file=sys.stderr);sys.exit(1)
  if not acl_mismatch([],['anon=r/postgres']):
   print('SELFTEST FAIL: acl_mismatch did not detect a column ACL grant -- the attacl coverage gap is back',file=sys.stderr);sys.exit(1)
  if relation_set_mismatch([],[]):
   print('SELFTEST FAIL: relation_set_mismatch on two empty sets returned True (false positive)',file=sys.stderr);sys.exit(1)
  if not relation_set_mismatch([],['zz_extra_trigger']):
   print('SELFTEST FAIL: relation_set_mismatch did not detect an extra trigger/rule name -- the extra-object gap is back',file=sys.stderr);sys.exit(1)
  if not relation_set_mismatch([],[{'name':'zz_policy','cmd':'*','roles':['authenticated'],'using':'true','withcheck':None,'permissive':True}]):
   print('SELFTEST FAIL: relation_set_mismatch did not detect an extra POLICY (dict-shaped entry) -- the policy gap is back',file=sys.stderr);sys.exit(1)
 finally:
  sql(f'DROP SCHEMA IF EXISTS {SCRATCH} CASCADE')
  sql(f'DROP SCHEMA IF EXISTS {SCRATCH}_src CASCADE')
 print('SELFTEST OK: the SAME functions --installed uses (scratch_function_stmt, scratch_trigger_stmt, assert_deparse_match, find_constraint_match, owner_mismatch, acl_mismatch, relation_set_mismatch) correctly distinguish real drift from cosmetic sameness for functions, owners, CHECK constraints, index predicates, triggers, function/relation/column ACLs (incl. WITH GRANT OPTION), and rewrite-rule/policy/trigger extra-object sets')
 sys.exit(0)

if a.installed:
 if a.target=='http':
  from http_fixture_db import guard,sql
 else:
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
 # Astra round 6: the full relation-level check (owner/ACL/persistence/
 # rewrite-rules/policies/exact-trigger-set) applies to every table THIS
 # CANDIDATE DECLARES (`tables`) -- both private-schema ones and the
 # explicitly-owned public ones (public.inbox_inbound_heads) -- scoped by
 # an explicit qualified-name array, never a namespace sweep of 'public'
 # (which has hundreds of unrelated pre-existing app objects this
 # candidate does not own and must never be asked to certify).
 owned_table_arr='ARRAY['+','.join("'"+t+"'" for t in tables)+']::text[]' if tables else "ARRAY[]::text[]"
 owned_schema_arr=private_arr  # schemas this candidate itself CREATEs; 'public' is never included (shared pre-existing schema, not owned)
 owned_type_arr='ARRAY['+','.join("'"+t+"'" for t in composite_types)+']::text[]' if composite_types else "ARRAY[]::text[]"

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
  trigger_tables=sorted(set(t for (t,_n) in expected_triggers))
  scratch_tables=sorted(set(constraint_tables)|set(index_tables)|set(trigger_tables))
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

  # Triggers: verbatim source statement retargeted at the scratch mirror
  # table via scratch_trigger_stmt (round-5, Astra gap #2) -- the
  # EXECUTE FUNCTION clause is left pointing at the REAL installed
  # function (read-only reference, never executed by CREATE TRIGGER), so
  # the rendered trigger def matches what the live trigger renders. Needs
  # both the scratch functions and scratch tables above to already exist.
  trigger_stmts_scratch=[]
  trigger_synth={}  # (table,name) -> synthetic scratch trigger name
  for (table,name),stmt in expected_triggers.items():
   retargeted,synth=scratch_trigger_stmt(table,name,stmt)
   trigger_stmts_scratch.append(retargeted)
   trigger_synth[(table,name)]=synth
  if trigger_stmts_scratch:sql('\n'.join(trigger_stmts_scratch))

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
   JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='{SCRATCH}'),
 'triggers',(SELECT coalesce(jsonb_object_agg(t.tgname,pg_get_triggerdef(t.oid)),'{{}}')
   FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='{SCRATCH}' AND NOT t.tgisinternal)
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
 'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'column',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notnull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'noncollation',a.attcollation<>0 AND a.attcollation<>t.typcollation,'attnum',a.attnum,'acl',coalesce(to_jsonb(a.attacl::text[]),'[]'::jsonb))),'[]')
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
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',n.nspname||'.'||c.relname,'def',pg_get_constraintdef(co.oid),'valid',co.convalidated,'noinherit',co.connoinherit,
    'triggers_ok',NOT EXISTS(SELECT 1 FROM pg_trigger tg WHERE tg.tgconstraint=co.oid AND tg.tgenabled<>'O'))),'[]')
   FROM pg_constraint co JOIN pg_class c ON c.oid=co.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE (n.nspname||'.'||c.relname)=ANY({constraint_arr})),
 'functions',(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'def',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
    'grants',(SELECT coalesce(jsonb_agg(jsonb_build_object(
       'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,
       'privilege_type',a.privilege_type,
       'grantable',a.is_grantable
      ) ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE gr.rolname END,a.privilege_type,a.is_grantable),'[]')
      FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      LEFT JOIN pg_roles gr ON gr.oid=a.grantee
      WHERE a.privilege_type='EXECUTE'
        AND a.grantee<>p.proowner))), '[]')
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
 'privilege_exposure',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname LIKE 'inbox\\_%' ESCAPE '\\' AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE') OR has_function_privilege('service_role',p.oid,'EXECUTE'))),
 -- Round 6 (Astra NO/6): full relation-level check, scoped by an explicit
 -- qualified-name array (owned_table_arr) so a PUBLIC owned table (e.g.
 -- public.inbox_inbound_heads) gets exactly the same coverage as a
 -- private-schema one, without sweeping unrelated public objects.
 'relations',(SELECT coalesce(jsonb_object_agg(n.nspname||'.'||c.relname,jsonb_build_object(
    'owner',c.relowner::regrole::text,
    'acl',coalesce(to_jsonb(c.relacl::text[]),'[]'::jsonb),
    'persistence',c.relpersistence,
    'rules',(SELECT coalesce(jsonb_agg(r.rulename),'[]') FROM pg_rewrite r WHERE r.ev_class=c.oid AND r.rulename<>'_RETURN'),
    'policies',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',p.polname,'permissive',p.polpermissive,'cmd',p.polcmd::text,
        'roles',(SELECT coalesce(jsonb_agg(rn.rolname ORDER BY rn.rolname),'[]') FROM unnest(p.polroles) x JOIN pg_roles rn ON rn.oid=x),
        'using',pg_get_expr(p.polqual,p.polrelid),'withcheck',pg_get_expr(p.polwithcheck,p.polrelid))),'[]')
      FROM pg_policy p WHERE p.polrelid=c.oid),
    'triggers',(SELECT coalesce(jsonb_agg(t.tgname),'[]') FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
   )),'{{}}')
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE (n.nspname||'.'||c.relname)=ANY({owned_table_arr})),
 'owned_schemas',(SELECT coalesce(jsonb_object_agg(nspname,jsonb_build_object('owner',nspowner::regrole::text,'acl',coalesce(to_jsonb(nspacl::text[]),'[]'::jsonb))),'{{}}')
   FROM pg_namespace WHERE nspname=ANY({owned_schema_arr})),
 'owned_types',(SELECT coalesce(jsonb_object_agg(n.nspname||'.'||t.typname,jsonb_build_object('owner',t.typowner::regrole::text,'acl',coalesce(to_jsonb(t.typacl::text[]),'[]'::jsonb))),'{{}}')
   FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE (n.nspname||'.'||t.typname)=ANY({owned_type_arr}))
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
  assert_deparse_match('Function',f'{schema}.{fname}',expected_def,row['def'])
  pin_key=f'{schema}.{fname}'
  expected_owner=pinned_owner(owner_pins,pin_key,'function-owners.json')
  if owner_mismatch(expected_owner,row['owner']):raise RuntimeError(f"Function OWNER drift {schema}.{fname}: expected owner={expected_owner!r} live={row['owner']!r} (for a SECURITY DEFINER function the owner is the execution principal)")
  # Grants (Astra round 5, gap #1): compare every non-owner direct function
  # ACL entry from aclexplode, including is_grantable, rather than using
  # has_function_privilege. The latter answers whether a role can execute but
  # loses both the distinction between EXECUTE and EXECUTE WITH GRANT OPTION
  # and direct grants to a worker role inherited by a browser role.
  expected_grants=grant_pins.get(pin_key)
  if expected_grants is None:raise RuntimeError(f'No pinned grant expectation for {pin_key} in function-grants.json -- add one before this can be certified')
  live_grants=row['grants']
  if acl_mismatch(expected_grants,live_grants):raise RuntimeError(f"Function ACL drift {schema}.{fname}: expected={sorted(expected_grants,key=repr)} live={sorted(live_grants,key=repr)} (aclexplode includes EXECUTE WITH GRANT OPTION)")
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
 # A column-level GRANT has a different catalog home (pg_attribute.attacl)
 # from a table GRANT (pg_class.relacl).  The reviewed candidate has no
 # column-specific GRANT syntax; reject a source change that would make the
 # empty ACL expectation stale instead of silently treating the new exposure
 # as a live-only drift.
 if re.search(r'\bGRANT\s+[A-Z ,]+\([^)]*\)\s+ON\s+',s,re.I):
  raise RuntimeError('Source candidate contains column-specific GRANT syntax but column-acl.json declares no-column-specific-grants')
 pinned_column_keys=set(column_acl_contract.get('columns',{}))
 live_column_keys={f"{t}.{name}" for t,cols in live_cols.items() for name in cols}
 unexpected_column_pins=pinned_column_keys-live_column_keys
 if unexpected_column_pins:
  raise RuntimeError('column-acl.json contains pins for columns absent from the candidate: '+str(sorted(unexpected_column_pins)))
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
   # Column-level GRANTs are independent of the table ACL and are therefore
   # invisible to relacl. Compare the generated pin when a native proof has
   # materialized one; the reviewed empty contract otherwise defaults to [].
   column_key=f'{t}.{name}'
   expected_column_acl=column_acl_contract.get('columns',{}).get(column_key,[])
   if acl_mismatch(expected_column_acl, row.get('acl', [])):raise RuntimeError(f"Column ACL drift {t}.{name}: expected={expected_column_acl} live={row.get('acl', [])}")

 # RLS: every ENABLE ROW LEVEL SECURITY table must still have it enabled live,
 # and FORCE ROW LEVEL SECURITY must match source (none of this candidate's
 # tables declare FORCE, so it must stay unforced -- a silently added FORCE
 # would change owner/superuser bypass semantics unreviewed).
 for t in rls_tables:
  if t not in snap['rls']:raise RuntimeError('RLS table missing from snapshot: '+t)
  if snap['rls'][t]['enabled'] is not True:raise RuntimeError('Row level security disabled on installed table: '+t)
  if snap['rls'][t]['forced'] is not False:raise RuntimeError('Unexpected FORCE ROW LEVEL SECURITY on installed table: '+t)

 # Relations (Astra round 6, gaps #1-#5): ownership, full ACL (incl. WITH
 # GRANT OPTION), persistence, rewrite rules and the exact policy/trigger
 # set, for EVERY table this candidate declares -- private-schema AND the
 # explicitly-owned public ones alike (owned_table_arr above), closing the
 # gap where a PUBLIC owned table (public.inbox_inbound_heads) escaped
 # every one of these checks even though a private-schema table was
 # already covered for some of them (owner bypasses RLS; an UNLOGGED table
 # is crash-truncatable; a rewrite rule can silently suppress/redirect
 # writes; an extra POLICY or TRIGGER can silently grant unreviewed access
 # or run unreviewed logic).
 for t in tables:
  rel=snap['relations'].get(t)
  if rel is None:raise RuntimeError(f'Installed relation missing from relation snapshot: {t}')
  pin_key=f'table:{t}'
  expected_owner=pinned_owner(relation_owner_pins,pin_key,'relation-owners.json')
  if owner_mismatch(expected_owner,rel['owner']):raise RuntimeError(f"Table OWNER drift {t}: expected owner={expected_owner!r} live={rel['owner']!r} (a table's OWNER bypasses RLS entirely, regardless of any policy)")
  expected_acl=relation_acl_pins.get(pin_key)
  if expected_acl is None:raise RuntimeError(f'No pinned ACL expectation for {pin_key} in relation-acl.json -- add one before this can be certified')
  live_acl=sorted(rel['acl'])
  if acl_mismatch(expected_acl,live_acl):raise RuntimeError(f"Table ACL drift {t}: expected={sorted(expected_acl)} live={live_acl} (raw aclitem text, so a WITH GRANT OPTION change -- a '*' suffix on a privilege letter -- is included)")
  if rel['persistence']!='p':raise RuntimeError(f"Table persistence drift {t}: expected permanent ('p'), live={rel['persistence']!r} -- an UNLOGGED table is crash-truncatable (silent data loss on the next crash/restart)")
  if relation_set_mismatch([],rel['rules']):raise RuntimeError(f"Unexpected rewrite rule(s) on {t}: {rel['rules']} (a rule can silently suppress or redirect writes to this table)")
  if relation_set_mismatch([],rel['policies']):raise RuntimeError(f"Unexpected RLS POLICY on {t}: {rel['policies']} (this candidate declares no CREATE POLICY anywhere -- every owned table relies on RLS-with-no-policies plus owner-bypass for its SECURITY DEFINER API functions, so ANY policy here is unreviewed)")
  expected_trig_names=sorted(n for (tt,n) in expected_triggers if tt==t)
  live_trig_names=sorted(rel['triggers'])
  if relation_set_mismatch(expected_trig_names,live_trig_names):raise RuntimeError(f"Trigger set drift on {t}: expected={expected_trig_names} live={live_trig_names} (an extra undeclared trigger can run unreviewed logic on every write)")

 for sch in private_schemas:
  schrow=snap['owned_schemas'].get(sch)
  if schrow is None:raise RuntimeError(f'Installed schema missing from schema snapshot: {sch}')
  pin_key=f'schema:{sch}'
  expected_owner=pinned_owner(relation_owner_pins,pin_key,'relation-owners.json')
  if owner_mismatch(expected_owner,schrow['owner']):raise RuntimeError(f"Schema OWNER drift {sch}: expected owner={expected_owner!r} live={schrow['owner']!r}")
  expected_acl=relation_acl_pins.get(pin_key)
  if expected_acl is None:raise RuntimeError(f'No pinned ACL expectation for {pin_key} in relation-acl.json -- add one before this can be certified')
  live_acl=sorted(schrow['acl'])
  if acl_mismatch(expected_acl,live_acl):raise RuntimeError(f"Schema ACL drift {sch}: expected={sorted(expected_acl)} live={live_acl}")

 for ct in composite_types:
  typerow=snap['owned_types'].get(ct)
  if typerow is None:raise RuntimeError(f'Installed type missing from type snapshot: {ct}')
  pin_key=f'type:{ct}'
  expected_owner=pinned_owner(relation_owner_pins,pin_key,'relation-owners.json')
  if owner_mismatch(expected_owner,typerow['owner']):raise RuntimeError(f"Type OWNER drift {ct}: expected owner={expected_owner!r} live={typerow['owner']!r}")
  expected_acl=relation_acl_pins.get(pin_key)
  if expected_acl is None:raise RuntimeError(f'No pinned ACL expectation for {pin_key} in relation-acl.json -- add one before this can be certified')
  live_acl=sorted(typerow['acl'])
  if acl_mismatch(expected_acl,live_acl):raise RuntimeError(f"Type ACL drift {ct}: expected={sorted(expected_acl)} live={live_acl}")

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
  assert_deparse_match('Index',name,expected_def,live['def'])
  if live['valid'] is not True:raise RuntimeError(f'Installed index is NOT VALID (failed/aborted build): {name}')

 # Triggers: byte-exact pg_get_triggerdef (scratch-rendered expected, via
 # scratch_trigger_stmt, vs live -- round 5, Astra gap #2: the old
 # field-by-field comparison lowercased and whitespace-stripped the
 # trigger's own args, so a capture arg 'property' -> 'PROPERTY' compared
 # equal; Postgres's own deparse preserves case verbatim, same fix as
 # functions/constraints/indexes), plus tgenabled. A retargeted/re-timed/
 # disabled trigger now fails here.
 live_trig={row['key']:row for row in snap['triggers']}
 for (table,name),stmt in expected_triggers.items():
  key=f"{table}.{name}"
  row=live_trig.get(key)
  if not row:raise RuntimeError(f'Installed trigger missing: {name} on {table}')
  if row['enabled']!='O':raise RuntimeError(f'Installed trigger disabled: {name} on {table} (tgenabled={row["enabled"]})')
  synth=trigger_synth.get((table,name))
  scratch_def=scratch_snap['triggers'].get(synth) if synth else None
  if scratch_def is None:raise RuntimeError(f'HARNESS FAILURE: scratch trigger missing for {name} on {table}')
  safe_table=scratch_name(table)
  expected_def=scratch_def.replace(synth,name).replace(f'{SCRATCH}.{safe_table}',table)
  assert_deparse_match('Trigger',f'{table}.{name}',expected_def,row['def'])

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
   hit=find_constraint_match(remaining,scratch_def)
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
   # Enforcement, not just presence (Astra round 5, gap #3): convalidated
   # only proves the constraint was checked against existing rows once at
   # validation time -- it says nothing about whether it is still ENFORCED
   # going forward. A FOREIGN KEY's actual runtime enforcement is two
   # internal (tgisinternal) triggers Postgres auto-creates -- one on this
   # table, one on the referenced table -- neither declared in source, both
   # invisible to the earlier snap['triggers'] query (which deliberately
   # excludes internal triggers, since they are never something source
   # declares). triggers_ok (computed in the live snapshot SQL from
   # pg_trigger.tgconstraint) is true only when EVERY trigger implementing
   # this exact constraint has tgenabled='O' -- an ALTER TABLE ... DISABLE
   # TRIGGER on any of them (the classic "quietly turn off FK enforcement
   # without touching the constraint row at all" bypass) now fails here.
   # Harmless no-op for CHECK/PK/UNIQUE constraints, which have no
   # implementing triggers at all (NOT EXISTS is trivially true for them).
   if hit['triggers_ok'] is not True:raise RuntimeError(f"Constraint enforcement disabled on {t}: {frag!r} is present and validated but its internal enforcement trigger(s) are disabled (tgenabled<>'O') -- writes are no longer actually checked against it")
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
 result={'foundation_sha256':digest,'target_profile':a.target,'installed_function_bodies':len(functions_src),'installed_tables':len(all_tables),'installed_composite_types':len(composite_types),'installed_indexes':len(expected_index),'installed_triggers':len(expected_triggers),'installed_constraints':sum(len(extract_constraints_for_table(t)) for t in constraint_tables),'installed_rls_tables':len(rls_tables),'private_schemas_scanned':len(private_schemas),'private_helper_exposure_count':0,'replica_identity':'FULL','snapshot_isolation':'REPEATABLE READ, READ ONLY, single transaction','scope':'Read-only owned fixture catalog proof (plus a throwaway verify_scratch schema, created and dropped within this same run, used only to let Postgres itself canonically render the expected side of every function/constraint/index/trigger/default comparison -- byte-exact pg_get_functiondef/pg_get_constraintdef/pg_get_indexdef/pg_get_triggerdef/pg_get_expr comparison, no custom text normalization, plus separately pinned function/table/schema/type owner and function/relation ACL checks, plus FK/constraint enforcement-trigger-enabled checks, plus table persistence/rewrite-rule/RLS-policy/extra-trigger checks applied uniformly to every table this candidate declares -- private-schema AND explicitly-owned public tables alike) taken from one consistent REPEATABLE READ snapshot for the live side, not merely name presence; excludes runtime throughput and production schema equivalence, and COMMENT metadata (cosmetic, not security-relevant)'}
 (P/'catalog-evidence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
else:
 print('Source syntax, pinned transforms and installation receipt hash verified')
