"""[Astra round-3 through round-7 — round 7 is the DEFINITIVE, FINAL closure]
Dynamic, exhaustive-by-construction, and HONEST residual verification,
shared by proof.py and runtime-proof.py. History of what this module
closes:
- round 3: leaked tables missed by hand-maintained enumeration (access_epochs;
  message_capture.*/operation_domain.*; inbox_t2_policy.versions/parent.work/
  maintained.queue/projection_proof.dirty).
- round 4: the counter-table discovery itself was too narrow —
  public.hugo_owner_guard_serialization (a shared, cross-fixture
  serialization counter the round-2 owner-guard trigger dance advances on
  every memberships DISABLE/ENABLE TRIGGER cycle) was outside the old
  `inbox_t2_*`/`inbox_operation_domain` schema pattern, never even
  snapshotted, and the printed "zero net residual" was FALSE.
- round 5: the counter/shared check only compared row count + one counter
  column's SUM — a synthetic content swap in any OTHER column of a
  counter/shared table passed silently.
- round 6: the round-5 content hash was applied only to the "neither org_id
  nor user_id" counter/shared set — an id-scoped table's PRE-EXISTING
  (non-synthetic) baseline rows were never hashed at all.
- round 7: rounds 3-6 each closed one CATEGORY of gap (org-scoped /
  user-scoped / counter-shared / id-scoped) by adding a NEW, SEPARATE code
  path for that category. Round 7 deleted the category distinction: ONE
  universe (every base table anywhere, PRIMARY_TABLES included), ONE
  content-signature check applied uniformly, ONE OWNED predicate.
- round 8 (this one, THE definitive, LOSSLESS closure): round 7 removed the
  category branching, but Astra found two remaining ALGORITHMIC gaps in the
  signature itself (not category exclusions):
  1. the counter check compared a table-WIDE SUM of the counter column — two
     rows in the same table, one +N and one -N, leave the sum unchanged and
     pass silently. Fixed by checking every counter row INDIVIDUALLY,
     grouped by that row's own non-counter content hash (its de facto
     identity, since that content is independently asserted unchanged) —
     see _counter_row_pairs_sql/assert_clean: a decrease in ANY single row
     fails, named by table+row-identity+column, never averaged away.
  2. the content hash was built via `to_jsonb(row)`, which re-serializes
     every column through jsonb's own (lossy) output — jsonb subcolumns get
     silently re-normalized on the way through (whitespace, and in some PG
     versions numeric formatting), so a real content mutation could produce
     an unchanged hash. Fixed by hashing each column's OWN native `::text`
     output directly (jsonb::text, numeric::text, bytea::text, array::text,
     etc. — each type's own exact, lossless textual representation, never
     routed through to_jsonb(record) at all) — see _row_hash_expr.
  There is no aggregation (SUM) and no normalization (to_jsonb) left
  anywhere in this module for a mutation to hide behind.
1. EXHAUSTIVE COVERAGE: every base table ANYWHERE in the database (any
   schema, never hardcoded, PRIMARY_TABLES included) is discovered via
   pg_catalog, excluding only the ephemeral reply-lane schemas that get
   DROP SCHEMA CASCADEd entirely each run (EPHEMERAL_SCHEMAS — querying them
   after the drop would error, not a coverage choice).
2. Cleanup SWEEPS every dynamically-discovered org_id/user_id-scoped table
   (not a hand-maintained list, PRIMARY_TABLES excluded here ONLY because
   the caller deletes those nine tables itself, in the correct FK/trigger
   order — the owner-guard trigger dance on memberships cannot be driven by
   a generic per-table DELETE), repeated for several passes so a table
   repopulated by another table's AFTER trigger (round 2) is still empty by
   the last pass.
"""

# Schemas created fresh and DROP SCHEMA CASCADEd entirely by the caller each
# run — querying them after the drop would error (table does not exist), and
# their rows can never leak because CASCADE removes them unconditionally.
# This is the ONLY exclusion from the uniform table universe, and it is
# mechanical (the tables cease to exist), not a coverage choice.
EPHEMERAL_SCHEMAS = {
    'inbox_reply_context', 'inbox_reply_preparation', 'inbox_reply_review',
    'inbox_reply_send', 'inbox_reply_send_scratch',
}
# Tables the caller deletes explicitly, in the correct FK/trigger order
# (owner-guard trigger dance on memberships, etc.) — excluded ONLY from
# sweep_delete's generic DELETE (a blind per-table sweep would fight the
# trigger dance), and from org_tables/user_tables, the subset sweep_delete
# consumes. NEVER excluded from the uniform content-signature check below —
# round 7's own escape was exactly a hand-maintained hash exclusion for
# these two tables (organizations.name).
PRIMARY_TABLES = {
    'public.organizations', 'auth.users', 'auth.sessions', 'public.memberships',
    'public.messages', 'public.contacts', 'public.properties',
    'public.consent_events', 'public.provider_sender_numbers',
}
# The two tables whose OWN `id` column (not an org_id/user_id column) is the
# owned identity — organizations and auth.users define identity rather than
# reference it, so there is no generic column-name rule that finds them.
# This is the one piece of real semantic knowledge this module needs; it is
# used only to build the OWNED predicate, never to exclude either table from
# the content signature (see round-7 history above).
ANCHOR_ID_TABLES = {'public.organizations': 'org', 'auth.users': 'user'}
# Column-name shape treated as a monotonic serialization/version counter when
# its SQL type is integer/bigint (never uuid/text — e.g.
# inbox_t2_capture_boundary.generation.generation is a uuid "generation id"
# that gets swapped, not an incrementing counter). This IS the whitelist:
# only a column matching this shape is ever excluded from the content hash
# or permitted to increase — every other column, on every table, is fully
# covered by the hash with zero exemptions.
COUNTER_COLUMN_PATTERN_SQL = r"a.attname ~* '(version|revision|generation|counter)$'"


def _rows(sql, query):
    out = sql(query)
    return [r for r in out.splitlines() if r.strip()]


_COLUMN_CACHE = {}


def _columns(sql, table):
    """[Astra round-8] The table's actual column list, in attnum order,
    memoized per process run (columns are structurally stable for the
    duration of one proof run — nothing in this module ever adds/drops a
    column). Used to build _row_hash_expr directly from each column's own
    type, instead of going through a composite-to-jsonb conversion that can
    silently re-normalize (and thereby lose) a column's real content."""
    if table not in _COLUMN_CACHE:
        schema, name = table.split('.', 1)
        _COLUMN_CACHE[table] = _rows(sql, f"""
            SELECT a.attname FROM pg_attribute a
            JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE c.relkind='r' AND n.nspname='{schema}' AND c.relname='{name}'
              AND a.attnum>0 AND NOT a.attisdropped
            ORDER BY a.attnum
        """)
    return _COLUMN_CACHE[table]


def _counter_column(sql, table):
    """The one whitelisted counter-shaped integer/bigint column on `table`,
    if any — applied uniformly regardless of whether `table` has org_id/
    user_id, so a legitimate monotonic counter advance (e.g.
    inbox_t2_policy.versions.revision, or hugo_owner_guard_serialization.
    version) is never mistaken for the content mutation this module exists
    to catch, on ANY table."""
    schema, name = table.split('.', 1)
    rows = _rows(sql, f"""
        SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND n.nspname='{schema}' AND c.relname='{name}'
          AND a.attnum>0 AND NOT a.attisdropped AND {COUNTER_COLUMN_PATTERN_SQL}
          AND format_type(a.atttypid,a.atttypmod) IN ('integer','bigint','smallint')
        ORDER BY a.attnum LIMIT 1
    """)
    return rows[0] if rows else None


def _all_tables(sql):
    """[Astra round-7] THE single uniform universe: EVERY base table
    anywhere in the database (any schema, PRIMARY_TABLES included, no
    org_id/user_id requirement — a table with neither, like
    hugo_owner_guard_serialization, is just as much a member as one with
    both), minus only EPHEMERAL_SCHEMAS (mechanical necessity, not a
    coverage exclusion). Returns [(table, has_org, has_user,
    counter_column_or_None)] — the one list every function below iterates,
    with no branching by category."""
    exclude_schemas = ','.join(f"'{s}'" for s in EPHEMERAL_SCHEMAS)
    rows = _rows(sql, f"""
        SELECT n.nspname||'.'||c.relname||'|'||
          coalesce(bool_or(a.attname='org_id'),false)||'|'||coalesce(bool_or(a.attname='user_id'),false)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname IN ('org_id','user_id')
        WHERE c.relkind='r'
          AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname<>'information_schema'
          AND n.nspname NOT IN ({exclude_schemas})
        GROUP BY n.nspname,c.relname ORDER BY 1
    """)
    out = []
    for r in rows:
        table, has_org, has_user = r.split('|')
        out.append((table, has_org == 'true', has_user == 'true', _counter_column(sql, table)))
    return out


def discover(sql):
    """Dynamic table discovery — call ONCE, before installing anything, so
    the caller can snapshot the baseline before any writes. Returns
    (org_tables, user_tables, all_tables):
    - org_tables/user_tables: PRIMARY_TABLES-excluded subset with org_id/
      user_id respectively — used ONLY by sweep_delete (which must not
      fight the caller's own hand-ordered PRIMARY_TABLES deletes).
    - all_tables [round 7]: the single uniform universe (see _all_tables) —
      every table anywhere, PRIMARY_TABLES included, used by every
      baseline/assertion function below. There is no separate "counter
      table" or "id table" list any more; a table's shape (has_org, has_user,
      counter column) is just data carried alongside it in this one list."""
    all_tables = _all_tables(sql)
    org_tables = [t for t, has_org, _, _ in all_tables if has_org and t not in PRIMARY_TABLES]
    user_tables = [t for t, _, has_user, _ in all_tables if has_user and t not in PRIMARY_TABLES]
    return org_tables, user_tables, all_tables


def _row_hash_expr(sql, table, exclude_col):
    """[Astra round-8] Per-row content hash built from each column's OWN
    native `::text` output, concatenated in a stable (attnum) order — never
    from `to_jsonb(row)`. This matters: converting a whole row to jsonb
    re-serializes every column THROUGH jsonb's own type system, which can
    silently re-normalize (and thereby lose) a column's real stored content
    — e.g. a jsonb subcolumn's exact text is not guaranteed byte-identical
    once re-emitted via to_jsonb(record). Casting each column directly to
    ::text instead uses that column's OWN type output function — jsonb::text
    is the value's own raw serialization (preserves array element order and
    duplicates exactly as stored), numeric::text preserves the exact stored
    scale/precision, bytea::text is a lossless hex encoding, array/composite/
    range/hstore::text likewise use their own faithful literal output. NULL
    is distinguished from any string via array_to_string's null_string arg
    (chr(1), never valid in these outputs) so NULL and '' can never collide.
    If a column's type has no meaningful ::text cast, Postgres raises at
    query time rather than this module silently falling back to a lossy
    encoding — a hard failure, never a silent narrowing of coverage."""
    cols = [c for c in _columns(sql, table) if c != exclude_col]
    if not cols:
        return "md5('')"
    parts = ','.join(f't."{c}"::text' for c in cols)
    return f"md5(array_to_string(ARRAY[{parts}], chr(2), chr(1)))"


def _content_hash_sql(sql, table, col, where=None):
    """One table-level digest over EVERY column except the whitelisted
    counter column (or every column, if col is None), optionally restricted
    to a WHERE clause: each row's _row_hash_expr, md5'd, sorted (so row
    order/physical layout never matters), joined, md5'd again. Applied to
    EVERY table with zero exceptions — including organizations and
    auth.users (round-7's closure) — using each column's raw ::text output,
    never to_jsonb (round-8's closure)."""
    row_hash = _row_hash_expr(sql, table, col)
    filt = f" WHERE {where}" if where else ""
    return f"SELECT md5(coalesce(string_agg(h,',' ORDER BY h),'')) FROM (SELECT {row_hash} AS h FROM {table} t{filt}) x"


def _counter_row_pairs_sql(sql, table, col, where=None):
    """[Astra round-8] One row per (row-identity-hash, counter-value) pair,
    as `hash:value` joined by commas — the raw material for a PER-ROW
    counter check (never a table-wide SUM, which lets one row's decrease be
    masked by another row's increase). The identity hash is the SAME
    per-row hash _content_hash_sql aggregates (every column except the
    counter), so a row's identity across before/after is exactly the set of
    columns this module already asserts is unchanged — grouping by it is
    sound: two rows can only share an identity if their entire non-counter
    content is byte-identical, in which case a sorted per-identity multiset
    comparison of their counters (see _parse_counter_pairs/assert_clean) is
    the correct, PK-free generalization of "this row's counter"."""
    row_hash = _row_hash_expr(sql, table, col)
    filt = f" WHERE {where}" if where else ""
    return f"SELECT coalesce(string_agg({row_hash} || ':' || t.{col}::text, ',' ORDER BY {row_hash}), '') FROM {table} t{filt}"


def _parse_counter_pairs(s):
    """Parse the `hash:value,hash:value,...` text _counter_row_pairs_sql
    returns into {identity_hash: sorted [int values]} — grouping and sorting
    here (not in SQL) keeps the per-row comparison logic in one place."""
    groups = {}
    if not s:
        return groups
    for part in s.split(','):
        h, v = part.rsplit(':', 1)
        groups.setdefault(h, []).append(int(v))
    for h in groups:
        groups[h].sort()
    return groups


def snapshot_baseline(sql, all_tables):
    """[Astra round-7/8] MUST run before any synthetic id this run will ever
    use exists — every row in every table is, by definition, a "baseline"
    row at this point, so each snapshot is unrestricted (no owned-id filter
    needed: nothing owned exists yet, so "every row" and "every non-owned
    row" are the same set). Per table: (row_count, content_hash,
    counter_pairs_or_None) — content_hash and counter_pairs both built from
    raw per-column ::text output (round 8), and counter_pairs is PER ROW
    (round 8), never a table-wide SUM."""
    snapshot = {}
    for table, _, _, col in all_tables:
        count = sql(f"SELECT count(*) FROM {table}")
        content_hash = sql(_content_hash_sql(sql, table, col))
        pairs = _parse_counter_pairs(sql(_counter_row_pairs_sql(sql, table, col))) if col else None
        snapshot[table] = (count, content_hash, pairs)
    return snapshot


def _text_array(ids):
    """A plain text[] literal, always explicitly typed (even when empty —
    an untyped `ARRAY[]` is a Postgres error) and never ::uuid[] — some
    discovered tables key org_id/user_id as varchar (e.g.
    auth.refresh_tokens), not uuid, so the column side is always cast to
    ::text instead and compared against this."""
    return "ARRAY[" + ','.join(f"'{i}'" for i in ids) + "]::text[]"


def sweep_delete(sql, org_tables, user_tables, owned_orgs, owned_users, passes=4):
    """Repeatedly DELETE FROM every dynamically-discovered org_id/user_id
    scoped table (excluding PRIMARY_TABLES, which the caller deletes itself,
    in order, beforehand). Repeated because an AFTER trigger on one table can
    repopulate another (round 2) — enough passes make delete order
    irrelevant instead of requiring it to be hand-derived per table. Tables
    with neither org_id nor user_id are never swept — they hold no synthetic
    rows to delete, only shared/counter content that assert_clean checks in
    place (see below)."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    for _ in range(passes):
        for t in org_tables:
            sql(f"DELETE FROM {t} WHERE org_id::text=ANY({orgs})", check=False)
        for t in user_tables:
            sql(f"DELETE FROM {t} WHERE user_id::text=ANY({users})", check=False)


def _owned_predicate(table, has_org, has_user, orgs, users):
    """[Astra round-7] The single OWNED predicate, uniform across the whole
    table universe: true for a row that DOES belong to one of this run's own
    synthetic ids. Every table's "ownedness" reduces to the same handful of
    column checks — an org_id column, a user_id column, or (for the two
    anchor tables only — organizations/auth.users define identity via their
    own `id` rather than referencing it) the table's own id. A table with
    none of these (a pure counter/shared table, e.g.
    hugo_owner_guard_serialization) can never hold an owned row, so its
    predicate is simply `false` — not a special case in the caller, just
    what falls out of having no owned-identity column at all."""
    parts = []
    anchor = ANCHOR_ID_TABLES.get(table)
    if anchor == 'org':
        parts.append(f"id::text=ANY({orgs})")
    if anchor == 'user':
        parts.append(f"id::text=ANY({users})")
    if has_org:
        parts.append(f"coalesce(org_id::text,'~NULL~')=ANY({orgs})")
    if has_user:
        parts.append(f"coalesce(user_id::text,'~NULL~')=ANY({users})")
    return ' OR '.join(parts) if parts else 'false'


def assert_clean(sql, all_tables, baseline, owned_orgs, owned_users):
    """[Astra round-8, the definitive, LOSSLESS closure] ONE uniform check,
    run identically over EVERY table in the universe — no org-scoped/
    user-scoped/counter/id-scoped branches, no PRIMARY_TABLES exemption, no
    aggregation and no normalization left for a mutation to hide behind:
      1. this run's OWN rows (the OWNED predicate) must be net-zero in every
         table — proves the sweep/explicit-delete actually removed them;
      2. every row NOT owned by this run must be byte-identical, in every
         column except a whitelisted counter column, to the pre-run
         baseline, hashed from each column's raw ::text output (round 8) —
         proves nothing else anywhere was mutated, including a jsonb
         column's exact content/array length, organizations.name, and
         auth.users, uniformly;
      3. a whitelisted counter column, when present, is checked PER ROW
         (round 8 — never a table-wide SUM), grouped by that row's own
         non-counter identity hash: a decrease in ANY single row fails,
         named by table+row-identity+column; an increase in any row is
         always reported by name, never silently accepted, never silently
         missed, never averaged against another row's decrease.
    Returns the list of benign "counter advanced" report lines and raises on
    any real residual, naming every offending table."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    residual = {}
    advanced = []
    for table, has_org, has_user, col in all_tables:
        owned_pred = _owned_predicate(table, has_org, has_user, orgs, users)
        if owned_pred == 'false':
            not_owned = 'true'
            owned_count = '0'
        else:
            not_owned = f'NOT ({owned_pred})'
            owned_count = sql(f"SELECT count(*) FROM {table} WHERE {owned_pred}")
        if owned_count != '0':
            residual[table] = f"{owned_count} of this run's own synthetic row(s) still present after cleanup (expected 0)"

        before_count, before_hash, before_pairs = baseline.get(table, ('?', '?', None))
        now_count = sql(f"SELECT count(*) FROM {table} WHERE {not_owned}")
        if before_count != '?' and now_count != before_count:
            residual[table] = residual.get(table, '') + f'; non-owned row count changed {before_count} -> {now_count} (a row was added to or removed from the pre-existing baseline, outside this run\'s own synthetic ids)'
        else:
            now_hash = sql(_content_hash_sql(sql, table, col, not_owned))
            if before_hash != '?' and now_hash != before_hash:
                residual[table] = residual.get(table, '') + f'; non-owned content hash changed {before_hash} -> {now_hash} (a mutation in a pre-existing row\'s non-counter column, hashed from raw ::text output — includes jsonb content/array length, organizations.name/auth.users, and every other table/type uniformly)'

        if col and before_pairs is not None:
            now_pairs = _parse_counter_pairs(sql(_counter_row_pairs_sql(sql, table, col, not_owned)))
            for row_id in set(before_pairs) | set(now_pairs):
                bvals, avals = before_pairs.get(row_id, []), now_pairs.get(row_id, [])
                if len(bvals) != len(avals):
                    continue  # a row's identity appearing/disappearing is already caught by the count/hash checks above
                for bv, av in zip(bvals, avals):  # both lists sorted ascending — the sound PK-free multiset comparison
                    if av < bv:
                        residual[table] = residual.get(table, '') + f'; {col} DECREASED {bv} -> {av} on row(identity={row_id[:12]}...) (per-row check — never masked by another row\'s increase via a table-wide SUM)'
                    elif av > bv:
                        advanced.append(f'{table}.{col} row {row_id[:12]}... +{av - bv} ({bv} -> {av})')

    if residual:
        raise RuntimeError(f'Owned-fixture cleanup left residual/unexplained changes across {len(residual)} dynamically-discovered table(s) (single uniform, lossless, per-row check over the whole database): {residual}')
    return advanced
